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
  :root{
    --bg: var(--vscode-editor-background);
    --panel: var(--vscode-sideBar-background);
    --text: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --link: var(--vscode-textLink-foreground);
    --border: var(--vscode-panel-border);
    --btn: var(--vscode-button-background);
    --btn-hover: var(--vscode-button-hoverBackground);
    --btn-fg: var(--vscode-button-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --focus: var(--vscode-focusBorder);
    --shadow: 0 0 0 1px var(--border);
    --radius: 12px;
    --bubble-user: var(--vscode-input-background);
    --bubble-model: var(--vscode-editorWidget-background);
  }
  html,body{height:100%}
  body{
    margin:0; background:var(--bg); color:var(--text);
    font-family: var(--vscode-font-family);
    display:grid; grid-template-rows:auto 1fr auto;
  }

  /* Top bar — centered actions, no title */
  .topbar{
    display:flex; align-items:center; justify-content:center; gap:8px;
    padding:8px 10px; border-bottom:1px solid var(--border);
  }
  .btn{
    background:var(--btn); color:var(--btn-fg);
    border:none; border-radius:8px; padding:6px 10px; cursor:pointer;
  }
  .btn:hover{ background:var(--btn-hover); }
  .btn[disabled]{ opacity:.6; cursor:not-allowed; }

  /* Chat scroll area */
  .scroll{ overflow:auto; padding:12px; }
  .thread{ max-width: 980px; margin: 0 auto; display:flex; flex-direction:column; gap:10px; }

  /* Status line */
  .status{ text-align:center; color:var(--muted); font-size:12px; margin:6px 0; }

  /* Bubbles */
  .row{ display:flex; }
  .bubble{
    max-width: 82%;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* LEFT = model/editor, RIGHT = user */
  .model { justify-content: flex-start; } /* left */
  .model .bubble{
    background: var(--bubble-model);
    border-top-left-radius: 6px;   /* tail-ish corner on left */
  }
  .user { justify-content: flex-end; } /* right */
  .user .bubble{
    background: var(--bubble-user);
    border-top-right-radius: 6px;  /* tail-ish corner on right */
  }

  .empty{
    display:grid; place-items:center; height:100%; color:var(--muted);
    font-size: 13px;
  }

  /* Composer — modern, inline send button, auto-grow */
  .composer{
    border-top:1px solid var(--border);
    background:var(--bg);
    padding: 12px;
  }
  .composer-inner{
    max-width: 980px; margin: 0 auto; position: relative;
  }
  .field{
    position: relative;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding-right: 44px; /* room for send button */
  }
  textarea#input{
    display:block; width:100%;
    background:transparent; color:inherit;
    border:none; outline:none; resize:none;
    padding: 10px 12px;
    min-height: 44px; max-height: 240px;
    line-height: 1.5; font-family: inherit; font-size: 13px;
  }
  .field:focus-within{ border-color: var(--focus); }
  .send{
    position:absolute; right:6px; bottom:6px;
    height:32px; min-width: 32px; padding:0 10px;
    display:flex; align-items:center; justify-content:center;
    border-radius:8px; border:none; cursor:pointer;
    background:var(--btn); color:var(--btn-fg);
  }
  .send:hover{ background: var(--btn-hover); }
</style>
</head>
<body>

  <div class="topbar">
    <button id="run" class="btn" title="Run last plan">Run</button>
    <button id="repair" class="btn" title="Repair last failure">Repair</button>
    <button id="settings" class="btn" title="Open settings">Settings</button>
    <button id="clear" class="btn" title="Clear history">Clear</button>
  </div>

  <div id="body" class="scroll">
    <div class="thread" id="thread">
      <div id="empty" class="empty">Ask about your code. Responses may be inaccurate.</div>
    </div>
  </div>

  <div class="composer">
    <div class="composer-inner">
      <div class="field">
        <textarea id="input" placeholder="Type a request… (Ctrl/Cmd+Enter to send)"></textarea>
        <button id="send" class="send" title="Send">Send</button>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (s)=>document.querySelector(s);
  const body = $("#body");
  const thread = $("#thread");
  let empty = $("#empty"); // will be reassigned after clear
  const input = /** @type {HTMLTextAreaElement} */ ($("#input"));
  const send = $("#send");
  const runBtn = $("#run");
  const repairBtn = $("#repair");
  const settingsBtn = $("#settings");
  const clearBtn = $("#clear");

  function scrollToBottom(){
    body.scrollTop = body.scrollHeight;
  }

  function addStatus(text){
    const el = document.createElement("div");
    el.className = "status";
    el.textContent = text;
    thread.appendChild(el);
    scrollToBottom();
    return el;
  }

  // LEFT = model, RIGHT = user
  function addBubble(role, text){
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "row " + (role === "model" ? "model" : "user");

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;

    row.appendChild(bubble);
    thread.appendChild(row);
    scrollToBottom();
  }

  function setOps({running, canRepair}) {
    runBtn.disabled = running;
    repairBtn.disabled = running || !canRepair;
  }

  function sendPrompt(){
    const text = (input.value || "").trim();
    if (!text) return;
    addBubble("user", text); // user on the right
    input.value = "";
    autoGrow();
    vscode.postMessage({ type: "prompt", text });
  }

  // Auto-grow textarea
  function autoGrow(){
    input.style.height = "auto";
    const next = Math.min(input.scrollHeight, 240);
    input.style.height = next + "px";
  }
  input.addEventListener("input", autoGrow);
  window.addEventListener("load", autoGrow);

  function clearThreadUI(){
    // Remove all children
    while (thread.firstChild) thread.removeChild(thread.firstChild);
    // Recreate placeholder
    const ph = document.createElement("div");
    ph.id = "empty";
    ph.className = "empty";
    ph.textContent = "Ask about your code. Responses may be inaccurate.";
    thread.appendChild(ph);
    empty = ph; // update ref
    scrollToBottom();
  }

  // Events
  send.addEventListener("click", sendPrompt);
  input.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      sendPrompt();
    }
  });
  runBtn.addEventListener("click", ()=> vscode.postMessage({ type: "run" }));
  repairBtn.addEventListener("click", ()=> vscode.postMessage({ type: "repair" }));
  settingsBtn.addEventListener("click", ()=> vscode.postMessage({ type: "open-settings" }));
  clearBtn.addEventListener("click", ()=> {
    clearThreadUI();                       // clear immediately in UI
    vscode.postMessage({ type: "clear-history" }); // then clear persisted history
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.type === "status") addStatus(msg.message);
    else if (msg?.type === "history") {
      // Render existing history using new alignment: model left, user right
      for (const h of msg.history) addBubble(h.role, h.text);
    }
    else if (msg?.type === "model") addBubble("model", msg.text);   // model/editor on left
    else if (msg?.type === "error") addBubble("model", "⚠️ " + msg.message);
    else if (msg?.type === "ops") setOps(msg);
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}
