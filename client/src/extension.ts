// src/extension.ts
import * as vscode from "vscode";
import { generatePlan, generateRepairPlan } from "./engine/gemini";
import { executePlan } from "./engine/executor";
import type { Plan } from "./engine/plan";
import { ChatViewProvider, ChatFromWeb } from "./ui/chatView";
import { withinWorkspace } from "./engine/sanitize";

let lastPlan: Plan | null = null;
let lastFolder: vscode.WorkspaceFolder | null = null;
let lastFailuresBrief: string | null = null;
let history: { role: "user" | "model"; text: string }[] = [];

/** -------- Revert store (per-plan snapshot) -------- */
type BeforeContent = string | null; // null => file did not exist
type RevertRecord = {
  folder: vscode.WorkspaceFolder;
  root: string; // plan.root
  before: Map<string, BeforeContent>; // relPath -> beforeContent|null
  createdAt: number;
};

const revertStore = new Map<string, RevertRecord>();

/** Stable stringify to use as plan id (sorts keys recursively) */
function stableStringify(value: any): string {
  const seen = new WeakSet();
  const walk = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return undefined; // avoid cycles (shouldn't happen)
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Collect rel file paths that will be modified by the plan (write/append/edit) */
function collectTouchedFiles(plan: Plan): string[] {
  const paths = new Set<string>();
  for (const s of plan.steps || []) {
    if ((s as any).path && (s.action === "write" || s.action === "append" || s.action === "edit")) {
      paths.add((s as any).path as string);
    }
  }
  return Array.from(paths);
}

/** Read file as utf8 if exists; return null if missing */
async function readUtf8IfExists(uri: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(buf).toString("utf8");
  } catch {
    return null;
  }
}

/** Ensure parent dir exists */
async function ensureDirForFile(uri: vscode.Uri) {
  const parent = vscode.Uri.file(require("path").dirname(uri.fsPath));
  try {
    await vscode.workspace.fs.createDirectory(parent);
  } catch {}
}

/** Write utf8 (creating parents) */
async function writeUtf8(uri: vscode.Uri, content: string) {
  await ensureDirForFile(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

/** Delete file if exists */
async function deleteIfExists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
  } catch {}
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("My Cursor");

  const chatProvider = new ChatViewProvider(context);
  history = chatProvider.loadHistory();

  function getExtCfg() {
    const cfg = vscode.workspace.getConfiguration("myCursor");
    return {
      autoRun: cfg.get<boolean>("autoRun", false),
      persistHistory: cfg.get<boolean>("persistHistory", true),
      autoRepair: cfg.get<boolean>("autoRepair", true),
      maxRepairAttempts: cfg.get<number>("maxRepairAttempts", 2),
    };
  }

  async function maybeSaveHistory() {
    await chatProvider.saveHistory(history);
  }

  async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    if (folders.length === 1) return folders[0];
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })),
      { title: "Select workspace folder for My Cursor" }
    );
    return pick?.f ?? null;
  }

  /** Run a plan with snapshot for revert */
  async function runPlan(plan: Plan, folder: vscode.WorkspaceFolder) {
    chatProvider.post({ type: "ops", running: true, canRepair: !!lastFailuresBrief });

    out.show(true);
    out.appendLine(`Goal: ${plan.goal}`);
    out.appendLine(`Root: ${plan.root}`);

    // ---- Snapshot before executing (only files touched by write/append/edit) ----
    const planId = stableStringify(plan);
    const before = new Map<string, BeforeContent>();
    try {
      const rootUri = withinWorkspace(folder.uri, plan.root || ".");
      for (const rel of collectTouchedFiles(plan)) {
        const fileUri = withinWorkspace(rootUri, rel);
        const prior = await readUtf8IfExists(fileUri);
        before.set(rel, prior); // null => didn't exist
      }
    } catch (e: any) {
      out.appendLine(`Snapshot warning: ${e?.message || String(e)}`);
    }

    try {
      const { results /*, tree*/ } = await executePlan(plan, folder, out);
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;

      // Save revert record only if we actually attempted to modify any files
      if (before.size > 0) {
        revertStore.set(planId, {
          folder,
          root: plan.root || ".",
          before,
          createdAt: Date.now(),
        });
      }

      lastFailuresBrief =
        failed === 0
          ? null
          : results
              .filter((r) => !r.ok)
              .map((r) => `- ${r.step}: ${"error" in r ? r.error : ""}`)
              .join("\n");

      // NOTE: No file tree in summary (UI renders compact info card)
      const summary =
        `▶️ Executed ${results.length} steps — OK: ${ok}, Failed: ${failed}` +
        (failed ? `\n\nFailures:\n${lastFailuresBrief}` : "");

      history.push({ role: "model", text: summary });
      await maybeSaveHistory();
      chatProvider.post({ type: "model", text: summary });
    } catch (e: any) {
      const msg = `My Cursor error (execute): ${e.message}`;
      out.appendLine(msg);
      lastFailuresBrief = `- runtime exception: ${e.message}`;
      history.push({ role: "model", text: "⚠️ " + msg });
      await maybeSaveHistory();
      chatProvider.post({ type: "error", message: msg });
    } finally {
      chatProvider.post({ type: "ops", running: false, canRepair: !!lastFailuresBrief });
    }
  }

  /** Revert changes captured for a specific plan */
  async function revertPlan(plan: Plan) {
    if (!lastFolder) {
      lastFolder = await pickWorkspaceFolder();
      if (!lastFolder) {
        vscode.window.showErrorMessage("Open/select a folder to revert changes.");
        return;
      }
    }
    const id = stableStringify(plan);
    const record = revertStore.get(id);
    if (!record) {
      vscode.window.showWarningMessage("No snapshot found for this plan to revert.");
      return;
    }

    const folder = record.folder;
    const rootUri = withinWorkspace(folder.uri, record.root || ".");
    const touched: string[] = [];

    try {
      for (const [rel, prev] of record.before.entries()) {
        const fileUri = withinWorkspace(rootUri, rel);
        if (prev === null) {
          // File did not exist before -> delete it
          await deleteIfExists(fileUri);
        } else {
          await writeUtf8(fileUri, prev);
        }
        touched.push(rel);
      }

      const note =
        `↩️ Reverted ${touched.length} file(s) from the selected plan.\n` +
        `Notes: shell/install/mkdir steps are not reverted.`;
      history.push({ role: "model", text: note });
      await maybeSaveHistory();
      chatProvider.post({ type: "model", text: note });
    } catch (e: any) {
      const msg = `Revert failed: ${e?.message || String(e)}`;
      history.push({ role: "model", text: "⚠️ " + msg });
      await maybeSaveHistory();
      chatProvider.post({ type: "error", message: msg });
    }
  }

  // Register the sidebar view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatProvider)
  );

  // Handle messages from the webview
  chatProvider.onMessage = async (m: ChatFromWeb) => {
    if (m.type === "ready") {
      chatProvider.post({ type: "ops", running: false, canRepair: !!lastFailuresBrief });
      return;
    }

    if (m.type === "open-settings") {
      vscode.commands.executeCommand("workbench.action.openSettings", "myCursor");
      return;
    }

    if (m.type === "clear-history") {
      history = [];
      chatProvider.clearHistory();
      vscode.window.showInformationMessage("My Cursor: History cleared.");
      return;
    }

    if (m.type === "run") {
      if (!lastPlan) {
        vscode.window.showWarningMessage("No plan ready. Ask for something first.");
        return;
      }
      if (!lastFolder) {
        lastFolder = await pickWorkspaceFolder();
        if (!lastFolder) {
          vscode.window.showErrorMessage("Open/select a folder to run My Cursor.");
          return;
        }
      }
      await runPlan(lastPlan, lastFolder);
      return;
    }

    if (m.type === "repair") {
      if (!lastFolder) {
        vscode.window.showWarningMessage("No previous run context.");
        return;
      }
      if (!lastFailuresBrief) {
        vscode.window.showInformationMessage("No failures to repair.");
        return;
      }

      const contextBrief =
        (lastPlan ? `previous goal: ${lastPlan.goal}\nroot: ${lastPlan.root}\n` : "") +
        `workspace: ${lastFolder.uri.fsPath}`;

      try {
        chatProvider.post({ type: "status", message: "Generating repair plan…" });
        const repair = await generateRepairPlan(context, lastFailuresBrief!, contextBrief, history);
        history.push({ role: "user", text: "[repair] " + lastFailuresBrief });
        history.push({ role: "model", text: JSON.stringify(repair) });
        await maybeSaveHistory();

        lastPlan = repair;
        chatProvider.post({ type: "model", text: "🛠️ Repair plan ready. Use Run to execute." });

        const { autoRun } = getExtCfg();
        if (autoRun) await runPlan(repair, lastFolder);
      } catch (e: any) {
        chatProvider.post({ type: "error", message: `Repair failed: ${e.message}` });
      }
      return;
    }

    if (m.type === "prompt") {
      // 1) Pick folder if needed
      if (!lastFolder) {
        lastFolder = await pickWorkspaceFolder();
        if (!lastFolder) {
          vscode.window.showErrorMessage("Open/select a folder to run My Cursor.");
          return;
        }
      }

      // 2) Plan
      try {
        chatProvider.post({ type: "status", message: "Generating plan…" });
        const plan = await generatePlan(context, m.text, history);

        // Record conversation
        history.push({ role: "user", text: m.text });
        history.push({ role: "model", text: JSON.stringify(plan) });
        await maybeSaveHistory();

        lastPlan = plan;
        chatProvider.post({ type: "model", text: `📝 Plan ready:\n${JSON.stringify(plan, null, 2)}` });

        // 3) Optional execute + auto-repair loop
        const { autoRun, autoRepair, maxRepairAttempts } = getExtCfg();

        if (!autoRun) {
          chatProvider.post({ type: "ops", running: false, canRepair: !!lastFailuresBrief });
          return;
        }

        // Autorun
        let attempts = 0;
        await runPlan(plan, lastFolder);

        while (autoRepair && lastFailuresBrief && attempts < maxRepairAttempts) {
          attempts++;
          const contextBrief =
            `previous goal: ${plan.goal}\nroot: ${plan.root}\nworkspace: ${lastFolder.uri.fsPath}`;
          chatProvider.post({
            type: "status",
            message: `Generating repair plan (attempt ${attempts}/${maxRepairAttempts})…`,
          });
          const repairPlan = await generateRepairPlan(
            context,
            lastFailuresBrief,
            contextBrief,
            history
          );

          history.push({ role: "user", text: `[auto-repair attempt ${attempts}] ${lastFailuresBrief}` });
          history.push({ role: "model", text: JSON.stringify(repairPlan) });
          await maybeSaveHistory();

          lastPlan = repairPlan;
          chatProvider.post({
            type: "model",
            text: `🛠️ Repair plan:\n${JSON.stringify(repairPlan, null, 2)}`,
          });

          await runPlan(repairPlan, lastFolder);
        }
      } catch (e: any) {
        chatProvider.post({ type: "error", message: `My Cursor error: ${e.message}` });
      }
      return;
    }

    // -------- NEW: run a specific plan from a plan card --------
    if (m.type === "run-plan") {
      const plan = m.plan as Plan;
      if (!plan || !Array.isArray(plan.steps)) {
        vscode.window.showErrorMessage("Invalid plan payload.");
        return;
      }
      if (!lastFolder) {
        lastFolder = await pickWorkspaceFolder();
        if (!lastFolder) {
          vscode.window.showErrorMessage("Open/select a folder to run My Cursor.");
          return;
        }
      }
      lastPlan = plan;
      // Record in history (so it persists) and echo to UI
      history.push({ role: "model", text: JSON.stringify(plan) });
      await maybeSaveHistory();
      await runPlan(plan, lastFolder);
      return;
    }

    // -------- NEW: revert a specific plan from a plan card --------
    if (m.type === "revert-plan") {
      const plan = m.plan as Plan;
      if (!plan || !Array.isArray(plan.steps)) {
        vscode.window.showErrorMessage("Invalid plan payload for revert.");
        return;
      }
      await revertPlan(plan);
      return;
    }
  };

  context.subscriptions.push(out);
}

export function deactivate() {}
