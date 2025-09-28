// src/ui/chatView.ts
import * as vscode from "vscode";

export type ChatToWeb =
  | { type: "ready" }
  | { type: "status"; message: string }
  | { type: "history"; history: { role: "user" | "model"; text: string }[] }
  | { type: "model"; text: string }
  | { type: "error"; message: string }
  | { type: "ops"; running: boolean; canRepair: boolean };

export type ChatFromWeb =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "clear-history" }
  | { type: "run" }
  | { type: "repair" }
  | { type: "open-settings" };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "my-cursor.chat";

  private view: vscode.WebviewView | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.html = this.html(webviewView.webview);

    // Initial handshake
    this.post({ type: "history", history: this.loadHistory() });

    webviewView.webview.onDidReceiveMessage((m: ChatFromWeb) => {
      this.onMessage?.(m);
    });
  }

  // -------- public helpers --------
  post(msg: ChatToWeb) {
    this.view?.webview.postMessage(msg);
  }

  onMessage?: (msg: ChatFromWeb) => void;

  // -------- persistence --------
  private readonly histKey = "my-cursor.history";

  loadHistory(): { role: "user" | "model"; text: string }[] {
    return (
      this.context.globalState.get<{ role: "user" | "model"; text: string }[]>(
        this.histKey
      ) ?? []
    );
  }

  async saveHistory(history: { role: "user" | "model"; text: string }[]) {
    const cfg = vscode.workspace.getConfiguration("myCursor");
    if (cfg.get<boolean>("persistHistory", true)) {
      await this.context.globalState.update(this.histKey, history.slice(-50));
    }
  }

  clearHistory() {
    void this.context.globalState.update(this.histKey, []);
  }

  // -------- HTML --------
  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).replace(".", "");
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Cursor — Chat</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --panel: var(--vscode-sideBar-background);
    --text: var(--vscode-foreground);
    --subtle: var(--vscode-descriptionForeground);
    --link: var(--vscode-textLink-foreground);
    --border: var(--vscode-panel-border);
    --btn: var(--vscode-button-background);
    --btn-hover: var(--vscode-button-hoverBackground);
    --btn-fg: var(--vscode-button-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --focus: var(--vscode-focusBorder);
    --shadow: 0 0 0 1px var(--border);
    --radius: 10px;
  }
  html,body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:var(--vscode-font-family); display:grid; grid-template-rows:auto 1fr auto; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border-bottom:1px solid var(--border); }
  .title { font-weight:600; letter-spacing:.2px; }
  .actions { display:flex; gap:8px; }
  .btn { background:var(--btn); color:var(--btn-fg); border:none; border-radius:8px; padding:6px 10px; cursor:pointer; }
  .btn:hover { background:var(--btn-hover); }
  .btn[disabled] { opacity:.6; cursor:not-allowed; }
  .scroll { overflow:auto; padding:10px; }
  .msg { max-width:880px; margin:10px auto; padding:12px 14px; border:1px solid var(--border); border-radius:var(--radius); background:var(--panel); box-shadow:var(--shadow); line-height:1.5; white-space:pre-wrap; word-break:break-word; }
  .msg.user { background:transparent; border-style:dashed; }
  .status { text-align:center; color:var(--subtle); font-size:12px; margin:8px 0; }
  .empty { display:grid; place-items:center; height:100%; color:var(--subtle); }
  .composer { border-top:1px solid var(--border); background:var(--bg); padding:10px; }
  .composer-inner { max-width:980px; margin:0 auto; display:grid; grid-template-columns:1fr auto; gap:10px; align-items:end; }
  .textarea { background:var(--input-bg); color:var(--input-fg); border:1px solid var(--border); border-radius:var(--radius); padding:10px 12px; min-height:48px; max-height:220px; overflow:auto; outline:none; }
  .textarea:focus { border-color:var(--focus); }
  .controls { display:flex; gap:8px; align-items:center; }
  .pill { border:1px solid var(--border); border-radius:999px; padding:8px 12px; background:var(--panel); box-shadow:var(--shadow); font-size:12px; line-height:1; white-space:nowrap; }
  .link { color:var(--link); text-decoration:none; }
</style>
</head>
<body>

  <div class="topbar">
    <div class="title">Chat</div>
    <div class="actions">
      <button id="run" class="btn" title="Run last plan">Run</button>
      <button id="repair" class="btn" title="Repair last failure">Repair</button>
      <button id="settings" class="btn" title="Open settings">Settings</button>
      <button id="clear" class="btn" title="Clear history">Clear</button>
    </div>
  </div>

  <div id="body" class="scroll">
    <div id="empty" class="empty">Ask about your code. Responses may be inaccurate.</div>
  </div>

  <div class="composer">
    <div class="composer-inner">
      <div id="input" class="textarea" contenteditable="true" spellcheck="true"></div>
      <div class="controls">
        <div class="pill">Ask ▾</div>
        <div class="pill">Model ▾</div>
        <button id="send" class="btn" title="Send (Ctrl/Cmd+Enter)">Send</button>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (s)=>document.querySelector(s);
  const body = $("#body");
  const empty = $("#empty");
  const input = $("#input");
  const send = $("#send");
  const runBtn = $("#run");
  const repairBtn = $("#repair");
  const settingsBtn = $("#settings");
  const clearBtn = $("#clear");

  function addStatus(text){
    const el = document.createElement("div");
    el.className = "status";
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }
  function addMsg(role, text){
    if (empty) empty.remove();
    const el = document.createElement("div");
    el.className = "msg " + role;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  function setOps({running, canRepair}) {
    runBtn.disabled = running;
    repairBtn.disabled = running || !canRepair;
  }

  function sendPrompt(){
    const text = (input.textContent || "").trim();
    if (!text) return;
    addMsg("user", text);
    input.textContent = "";
    vscode.postMessage({ type: "prompt", text });
  }

  send.addEventListener("click", sendPrompt);
  input.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") sendPrompt();
  });
  runBtn.addEventListener("click", ()=> vscode.postMessage({ type: "run" }));
  repairBtn.addEventListener("click", ()=> vscode.postMessage({ type: "repair" }));
  settingsBtn.addEventListener("click", ()=> vscode.postMessage({ type: "open-settings" }));
  clearBtn.addEventListener("click", ()=> vscode.postMessage({ type: "clear-history" }));

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.type === "status") addStatus(msg.message);
    else if (msg?.type === "history") for (const h of msg.history) addMsg(h.role, h.text);
    else if (msg?.type === "model") addMsg("model", msg.text);
    else if (msg?.type === "error") addMsg("model", "⚠️ " + msg.message);
    else if (msg?.type === "ops") setOps(msg);
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}
