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
  | { type: "open-settings" }
  | { type: "run-plan"; plan: any }
  | { type: "revert-plan"; plan: any };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "my-cursor.chat";

  private view: vscode.WebviewView | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html(webviewView.webview);

    // Send history only after the webview tells us it's ready.
    webviewView.webview.onDidReceiveMessage((m: ChatFromWeb) => {
      if (m?.type === "ready") {
        this.post({ type: "history", history: this.loadHistory() });
      }
      this.onMessage?.(m);
    });
  }

  post(msg: ChatToWeb) {
    this.view?.webview.postMessage(msg);
  }

  onMessage?: (msg: ChatFromWeb) => void;

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
    --accent: var(--vscode-textLink-foreground);
    --highlight: var(--vscode-focusBorder);
  }
  html,body{height:100%}
  body{
    margin:0; background:var(--bg); color:var(--text);
    font-family: var(--vscode-font-family);
    display:grid; grid-template-rows:auto 1fr auto;
  }

  /* Top bar — icon-only buttons */
  .topbar{
    display:flex; align-items:center; justify-content:center; gap:10px;
    padding:8px 10px; border-bottom:1px solid var(--border);
  }
  .btn{
    width:32px; height:32px;
    display:grid; place-items:center;
    background:linear-gradient(180deg, var(--card-bg), var(--panel));
    color:var(--btn-fg);
    border:1px solid var(--border);
    border-radius:10px;
    box-shadow: 0 1px 0 rgba(0,0,0,.15), inset 0 0 0 1px rgba(255,255,255,.03);
    cursor:pointer;
    transition: transform .06s ease, background .15s ease, border-color .15s ease;
    font-size:14px;
    line-height:1;
  }
  .btn:hover{ background:var(--btn-hover); transform: translateY(-1px); }
  .btn:active{ transform: translateY(0); }
  .btn:focus-visible{ outline: 2px solid var(--focus); outline-offset: 2px; }
  .btn[disabled]{ opacity:.6; cursor:not-allowed; transform:none; }

  .scroll{ overflow:auto; padding:10px; }
  .thread{ max-width: 980px; margin: 0 auto; display:flex; flex-direction:column; gap:8px; }

  /* Compact info/status card (clickable when linked) */
  .info{
    align-self:center;
    max-width: 92%;
    background: var(--card-bg);
    border: 1px dashed var(--border);
    border-radius: 10px;
    padding: 6px 8px;
    color: var(--text);
    opacity: 0.95;
    font-size: 11.5px;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
    transition: border-color .15s ease, background .15s ease, transform .06s ease;
  }
  .info.linked{ cursor: pointer; }
  .info.linked:hover{ border-color: var(--link); transform: translateY(-1px); }
  .info .note{
    display:block;
    margin-top:4px;
    font-size: 10.5px;
    opacity: 0.85;
  }

  /* Bubbles */
  .row{ display:flex; }
  .bubble{
    max-width: 82%;
    padding: 8px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    line-height: 1.45;
    font-size: 12.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .model { justify-content: flex-start; }
  .model .bubble{ background: var(--bubble-model); border-top-left-radius: 6px; }
  .user { justify-content: flex-end; }
  .user .bubble{ background: var(--bubble-user); border-top-right-radius: 6px; }

  /* Plan card */
  .card{
    max-width: 82%;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 8px 10px;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .card.model { align-self: flex-start; }
  .card-head{
    display:flex; align-items:center; justify-content: space-between; gap: 10px;
    margin-bottom:6px;
  }
  .card-title{ font-weight:600; font-size:12.5px; }
  .card-actions{ display:flex; align-items:center; gap:6px; }
  .icon-btn{
    width:28px; height:28px;
    display:grid; place-items:center;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    font-size: 12px; line-height: 1;
    transition: transform .06s ease, background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
  }
  .icon-btn:hover{ border-color: var(--focus); color: var(--accent); transform: translateY(-1px); }
  .icon-btn:active{ transform: translateY(0); }
  .icon-btn[disabled]{ opacity: .5; cursor: not-allowed; transform:none; }

  /* Code block */
  pre.code{
    margin:0;
    padding:8px 10px;
    border-radius: 8px;
    border:1px solid var(--border);
    background: var(--vscode-editor-background);
    overflow-y: auto; overflow-x: hidden;
    max-height: 340px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
  }

  .empty{
    display:grid; place-items:center; height:100%; color:var(--muted);
    font-size: 13px;
  }

  /* Composer */
  .composer{ border-top:1px solid var(--border); background:var(--bg); padding: 10px; }
  .composer-inner{ max-width: 980px; margin: 0 auto; position: relative; }
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
    padding: 8px 10px;
    height: calc(1.45em + 16px);
    min-height: calc(1.45em + 16px);
    max-height: 220px;
    line-height: 1.45;
    font-family: inherit; font-size: 12.5px;
  }
  .field:focus-within{ border-color: var(--focus); }
  .send{
    position:absolute; right:6px; bottom:6px;
    width:30px; height:30px;
    display:grid; place-items:center;
    border-radius:8px; border:1px solid var(--border); cursor:pointer;
    background:linear-gradient(180deg, var(--card-bg), var(--panel)); color:var(--btn-fg);
    font-size:12px;
    transition: transform .06s ease, background .15s ease, border-color .15s ease;
  }
  .send:hover{ background: var(--btn-hover); transform: translateY(-1px); }
  .send:active{ transform: translateY(0); }

  /* Highlight for linked plan */
  .highlight-plan {
    outline: 2px solid var(--highlight);
    outline-offset: 2px;
    border-color: var(--highlight) !important;
    transition: outline-color .15s ease, border-color .15s ease;
  }
</style>
</head>
<body>

  <div class="topbar">
    <button id="run" class="btn" title="Run last plan (▷)"><span class="icon">▷</span></button>
    <button id="repair" class="btn" title="Repair last failure (🛠)"><span class="icon">🛠️</span></button>
    <button id="settings" class="btn" title="Open settings (⚙)"><span class="icon">⚙️</span></button>
    <button id="clear" class="btn" title="Clear history (🗑)"><span class="icon">🗑️</span></button>
  </div>

  <div id="body" class="scroll">
    <div class="thread" id="thread">
      <div id="empty" class="empty">Ask about your code. Responses may be inaccurate.</div>
    </div>
  </div>

  <div class="composer">
    <div class="composer-inner">
      <div class="field">
        <textarea id="input" rows="1" placeholder="Type a request… (Ctrl/Cmd+Enter to send)"></textarea>
        <button id="send" class="send" title="Send (Ctrl/Cmd+Enter)">➤</button>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (s)=>document.querySelector(s);
  const body = $("#body");
  const thread = $("#thread");
  let empty = $("#empty");
  const input = /** @type {HTMLTextAreaElement} */ ($("#input"));
  const send = $("#send");
  const runBtn = $("#run");
  const repairBtn = $("#repair");
  const settingsBtn = $("#settings");
  const clearBtn = $("#clear");

  // ---- Plan tracking state ----
  /** @type {Map<string, HTMLElement>} */
  const planCards = new Map(); // planKey -> card element
  /** @type {string|null} */ let lastGeneratedPlanKey = null; // newest rendered plan (non-history)
  /** @type {string|null} */ let pendingRunPlanKey = null;    // set when user clicks "Run this plan"
  /** @type {string|null} */ let pendingRevertPlanKey = null; // set when user clicks "Revert this plan"
  /** @type {string|null} */ let lastExecutedPlanKey = null;  // authoritative last executed plan

  function scrollToBottom(){ body.scrollTop = body.scrollHeight; }

  // ------- Helpers -------
  function stripFileTree(text){
    const m = text.match(/\\n\\s*File tree[\\s\\S]*$/i);
    if (m) return text.slice(0, m.index).trim();
    return text;
  }

  function tryParsePlan(text){
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

  function planKeyOf(obj){ try { return JSON.stringify(obj); } catch { return null; } }

  function isExecutionSummary(text){
    return /▶️\\s*Executed\\s+\\d+\\s+steps/i.test(text) || /\\bExecuted\\s+\\d+\\s+steps\\b/i.test(text);
  }

  function isRevertSummary(text){
    return /↩️\\s*Reverted\\s+\\d+\\s+file/i.test(text);
  }

  function setOps({running, canRepair}) {
    runBtn.disabled = running;
    repairBtn.disabled = running || !canRepair;
  }

  function ensureEmptyRemoved(){
    if (empty) { empty.remove(); empty = null; }
  }

  // ---- Revert button enable/disable based on lastExecutedPlanKey ----
  function updateRevertButtons(){
    for (const [key, card] of planCards.entries()) {
      const revertBtn = card.querySelector('.icon-btn[data-role="revert"]');
      if (!revertBtn) continue;
      if (lastExecutedPlanKey && key === lastExecutedPlanKey) {
        revertBtn.removeAttribute("disabled");
        revertBtn.removeAttribute("title");
      } else {
        revertBtn.setAttribute("disabled", "true");
        revertBtn.setAttribute("title", "Only the last executed plan can be reverted.");
      }
    }
  }

  // ---- Highlight + scroll to plan ----
  function focusPlanByKey(key){
    if (!key) return;
    const card = planCards.get(key);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("highlight-plan");
    setTimeout(()=> card.classList.remove("highlight-plan"), 1800);
  }

  // ------- UI adders -------
  function addInfoCard(raw, linkKey = null){
    // If revert summary, reshape to main line + note line
    if (isRevertSummary(raw)) {
      const [firstLine, ...rest] = raw.split(/\\r?\\n/);
      const notesIdx = rest.findIndex(l => /^Notes:/i.test(l.trim()));
      const noteLine = notesIdx >= 0 ? rest[notesIdx].replace(/^Notes:\\s*/i, "").trim() : "";
      ensureEmptyRemoved();
      const el = document.createElement("div");
      el.className = "info" + (linkKey ? " linked" : "");
      const main = document.createElement("div");
      main.textContent = firstLine;
      el.appendChild(main);
      if (noteLine) {
        const note = document.createElement("span");
        note.className = "note";
        note.textContent = "Notes: " + noteLine;
        el.appendChild(note);
      }
      if (linkKey) {
        el.title = "Jump to plan";
        el.addEventListener("click", () => focusPlanByKey(linkKey));
      }
      thread.appendChild(el);
      scrollToBottom();
      return;
    }

    const text = stripFileTree(raw);
    ensureEmptyRemoved();
    const el = document.createElement("div");
    el.className = "info" + (linkKey ? " linked" : "");
    el.innerText = text;
    if (linkKey) {
      el.title = "Jump to plan";
      el.addEventListener("click", () => focusPlanByKey(linkKey));
    }
    thread.appendChild(el);
    scrollToBottom();
  }

  function addPlanCard(planObj, title = "📝 Generated Plan"){
    ensureEmptyRemoved();
    const wrapper = document.createElement("div");
    wrapper.className = "card model";
    const key = planKeyOf(planObj);
    if (key) {
      wrapper.dataset.planKey = key;
      planCards.set(key, wrapper);
    }

    const head = document.createElement("div");
    head.className = "card-head";

    const header = document.createElement("div");
    header.className = "card-title";
    header.textContent = title + (planObj?.goal ? " — " + String(planObj.goal) : "");

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const runOne = document.createElement("button");
    runOne.className = "icon-btn";
    runOne.title = "Run this plan";
    runOne.textContent = "▷";
    runOne.addEventListener("click", (e) => {
      e.stopPropagation();
      if (key) pendingRunPlanKey = key; // remember which plan we asked to run
      vscode.postMessage({ type: "run-plan", plan: planObj });
    });

    const revertOne = document.createElement("button");
    revertOne.className = "icon-btn";
    revertOne.setAttribute("data-role", "revert");
    revertOne.title = "Revert this plan";
    revertOne.textContent = "↩︎";
    revertOne.addEventListener("click", (e) => {
      e.stopPropagation();
      if (key) pendingRevertPlanKey = key;
      vscode.postMessage({ type: "revert-plan", plan: planObj });
    });

    actions.appendChild(runOne);
    actions.appendChild(revertOne);
    head.appendChild(header);
    head.appendChild(actions);

    const pre = document.createElement("pre");
    pre.className = "code";
    pre.textContent = JSON.stringify(planObj, null, 2);

    wrapper.appendChild(head);
    wrapper.appendChild(pre);
    thread.appendChild(wrapper);
    scrollToBottom();

    // On every card render, refresh revert button states
    updateRevertButtons();
  }

  function addBubble(role, text){
    ensureEmptyRemoved();
    const row = document.createElement("div");
    row.className = "row " + (role === "model" ? "model" : "user");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    row.appendChild(bubble);
    thread.appendChild(row);
    scrollToBottom();
  }

  function renderModelMessage(text, {fromHistory} = {fromHistory:false}){
    const maybePlan = tryParsePlan(text);
    if (maybePlan) {
      const key = planKeyOf(maybePlan);
      const label = fromHistory ? "📝 Plan (from history)" : "📝 Plan ready";
      addPlanCard(maybePlan, label);
      if (!fromHistory) {
        // If this plan was freshly generated (not history), remember; useful for autorun
        lastGeneratedPlanKey = key;
      }
      // Every time a new plan appears, revert buttons may change (if lastExecuted is elsewhere)
      updateRevertButtons();
      return;
    }

    // Decide if this is an execution or revert summary; if yes, make it clickable to last executed key
    if (isExecutionSummary(text)) {
      // Link strategy: prefer a user-initiated pending run, else fallback to last generated plan
      const linkKey = pendingRunPlanKey || lastGeneratedPlanKey || lastExecutedPlanKey;
      // Update authoritative pointer: this info card indicates a run just completed
      if (linkKey) {
        lastExecutedPlanKey = linkKey;
        pendingRunPlanKey = null; // consume
        updateRevertButtons();
      }
      addInfoCard(text, linkKey || null);
      // Auto focus briefly to reinforce association
      if (linkKey) setTimeout(() => focusPlanByKey(linkKey), 150);
      return;
    }

    if (isRevertSummary(text)) {
      // Link to the plan we just requested to revert; fall back to lastExecuted
      const linkKey = pendingRevertPlanKey || lastExecutedPlanKey;
      pendingRevertPlanKey = null;
      addInfoCard(text, linkKey || null);
      if (linkKey) setTimeout(() => focusPlanByKey(linkKey), 150);
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

  // One-line initial height, then grow
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

    // Reset local UI-only state
    planCards.clear();
    lastGeneratedPlanKey = null;
    pendingRunPlanKey = null;
    pendingRevertPlanKey = null;
    lastExecutedPlanKey = null;
    scrollToBottom();
  }

  // Buttons (icon-only with tooltips)
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
      // Status cards aren't linked to a plan
      addInfoCard(msg.message, null);
    } else if (msg?.type === "history") {
      // Reset then render; dedupe identical plan JSONs
      clearThreadUI();
      const seenPlanKeys = new Set();
      for (const h of msg.history) {
        if (h.role === "model") {
          const planObj = tryParsePlan(h.text);
          if (planObj) {
            const key = planKeyOf(planObj);
            if (key) {
              if (seenPlanKeys.has(key)) continue;
              seenPlanKeys.add(key);
            }
            renderModelMessage(h.text, { fromHistory: true });
            continue;
          }
          // For history info cards we cannot reliably infer which plan they belong to;
          // render non-clickable.
          addInfoCard(stripFileTree(h.text), null);
        } else {
          addBubble("user", h.text);
        }
      }
      // After restoring history, we don't know lastExecutedPlanKey; keep revert disabled.
      updateRevertButtons();
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
