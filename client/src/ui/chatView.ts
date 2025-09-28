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
    --card-bg: var(--vscode-editorWidget-background);
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
    font-size:12px;
  }
  .btn:hover{ background:var(--btn-hover); }
  .btn[disabled]{ opacity:.6; cursor:not-allowed; }

  /* Chat scroll area */
  .scroll{ overflow:auto; padding:10px; }
  .thread{ max-width: 980px; margin: 0 auto; display:flex; flex-direction:column; gap:8px; }

  /* Compact info/status card */
  .info{
    align-self:center;
    max-width: 92%;
    background: var(--card-bg);
    border: 1px dashed var(--border);
    border-radius: 10px;
    padding: 8px 10px;          /* reduced padding */
    color: var(--text);
    opacity: 0.95;
    font-size: 12px;            /* smaller font */
    line-height: 1.45;
    white-space: pre-wrap;      /* preserve newlines, wrap long lines */
    word-break: break-word;
  }
  .info strong{ font-weight: 600; }

  /* Bubbles (compact) */
  .row{ display:flex; }
  .bubble{
    max-width: 82%;
    padding: 8px 10px;          /* reduced padding */
    border-radius: var(--radius);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    line-height: 1.45;          /* slightly tighter */
    font-size: 12.5px;          /* slightly smaller text */
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* LEFT = model/editor, RIGHT = user */
  .model { justify-content: flex-start; } /* left */
  .model .bubble{
    background: var(--bubble-model);
    border-top-left-radius: 6px;
  }
  .user { justify-content: flex-end; } /* right */
  .user .bubble{
    background: var(--bubble-user);
    border-top-right-radius: 6px;
  }

  /* Card (for formatted plan JSON etc.) — compact */
  .card{
    max-width: 82%;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 8px 10px;          /* reduced padding */
    font-size: 12.5px;
    line-height: 1.45;
  }
  .card.model { align-self: flex-start; }
  .card.user { align-self: flex-end; }
  .card-title{ font-weight:600; margin-bottom:6px; font-size:12.5px; }

  /* Code block — wrap long content vertically, no horizontal scroll */
  pre.code{
    margin:0;
    padding:8px 10px;           /* reduced padding */
    border-radius: 8px;
    border:1px solid var(--border);
    background: var(--vscode-editor-background);
    overflow-y: auto;           /* vertical scroll only when needed */
    overflow-x: hidden;         /* prevent horizontal scroll */
    max-height: 340px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;      /* <-- wrap long strings */
    word-break: break-word;     /* break long tokens */
  }

  .empty{
    display:grid; place-items:center; height:100%; color:var(--muted);
    font-size: 13px;
  }

  /* Composer — modern, inline send button, auto-grow */
  .composer{
    border-top:1px solid var(--border);
    background:var(--bg);
    padding: 10px;
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
    padding: 8px 10px;          /* reduced padding */
    min-height: 40px;           /* slightly smaller min height */
    max-height: 220px;          /* slightly smaller max height */
    line-height: 1.45;
    font-family: inherit; font-size: 12.5px;
  }
  .field:focus-within{ border-color: var(--focus); }
  .send{
    position:absolute; right:6px; bottom:6px;
    height:30px; min-width: 30px; padding:0 10px; /* slightly smaller */
    display:flex; align-items:center; justify-content:center;
    border-radius:8px; border:none; cursor:pointer;
    background:var(--btn); color:var(--btn-fg);
    font-size:12px;
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

  // ------- Helpers for special rendering -------

  function stripFileTree(text){
    // Remove "File tree..." and anything after
    const m = text.match(/\\n\\s*File tree[\\s\\S]*$/i);
    if (m) return text.slice(0, m.index).trim();
    return text;
  }

  function tryParsePlan(text){
    // Extract the largest {...} block and try to parse
    try {
      const pure = JSON.parse(text);
      if (pure && typeof pure === "object" && Array.isArray(pure.steps)) return pure;
    } catch {}
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last >= 0 && last > first) {
      const slice = text.slice(first, last + 1);
      try {
        const obj = JSON.parse(slice);
        if (obj && typeof obj === "object" && Array.isArray(obj.steps)) return obj;
      } catch {}
    }
    return null;
  }

  function isExecutionSummary(text){
    return /▶️\\s*Executed\\s+\\d+\\s+steps/i.test(text) || /\\bExecuted\\s+\\d+\\s+steps\\b/i.test(text);
  }

  // ------- UI adders -------

  function addInfoCard(raw){
    const text = stripFileTree(raw);
    if (empty) empty.remove();
    const el = document.createElement("div");
    el.className = "info";
    el.innerText = text; // keep newlines, wrap long lines
    thread.appendChild(el);
    scrollToBottom();
  }

  function addPlanCard(roleLabel, planObj, title = "📝 Generated Plan"){
    if (empty) empty.remove();
    const wrapper = document.createElement("div");
    wrapper.className = "card model";
    const header = document.createElement("div");
    header.className = "card-title";
    header.textContent = title + (planObj?.goal ? " — " + String(planObj.goal) : "");
    const pre = document.createElement("pre");
    pre.className = "code";
    pre.textContent = JSON.stringify(planObj, null, 2); // pretty + wrapped via CSS
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
    thread.appendChild(wrapper);
    scrollToBottom();
  }

  function addStatus(text){
    addInfoCard(text);
  }

  // LEFT = model, RIGHT = user (bubbles)
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

  function renderModelMessage(text, {fromHistory} = {fromHistory:false}){
    const maybePlan = tryParsePlan(text);
    if (maybePlan) {
      const label = fromHistory ? "📝 Plan (from history)" : "📝 Plan ready";
      addPlanCard("model", maybePlan, label);
      return;
    }

    if (isExecutionSummary(text)) {
      addInfoCard(text);
      return;
    }

    addBubble("model", stripFileTree(text));
  }

  // ------- Composer & events -------

  function sendPrompt(){
    const text = (input.value || "").trim();
    if (!text) return;
    addBubble("user", text);
    input.value = "";
    autoGrow();
    vscode.postMessage({ type: "prompt", text });
  }

  // Auto-grow textarea
  function autoGrow(){
    input.style.height = "auto";
    const next = Math.min(input.scrollHeight, 220);
    input.style.height = next + "px";
  }
  input.addEventListener("input", autoGrow);
  window.addEventListener("load", autoGrow);

  function clearThreadUI(){
    while (thread.firstChild) thread.removeChild(thread.firstChild);
    const ph = document.createElement("div");
    ph.id = "empty";
    ph.className = "empty";
    ph.textContent = "Ask about your code. Responses may be inaccurate.";
    thread.appendChild(ph);
    empty = ph;
    scrollToBottom();
  }

  // Buttons
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
    clearThreadUI();
    vscode.postMessage({ type: "clear-history" });
  });

  // Message pump
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.type === "status") {
      addStatus(msg.message);
    } else if (msg?.type === "history") {
      for (const h of msg.history) {
        if (h.role === "model") {
          renderModelMessage(h.text, { fromHistory: true });
        } else {
          addBubble("user", h.text);
        }
      }
    } else if (msg?.type === "model") {
      renderModelMessage(msg.text, { fromHistory: false });
    } else if (msg?.type === "error") {
      renderModelMessage("⚠️ " + msg.message, { fromHistory: false });
    } else if (msg?.type === "ops") {
      setOps(msg);
    }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}
