// src/extension.ts
import * as vscode from "vscode";
import { generatePlan, generateRepairPlan } from "./engine/gemini";
import { executePlan } from "./engine/executor";
import type { Plan } from "./engine/plan";
import { ChatViewProvider, ChatFromWeb } from "./ui/chatView";

let lastPlan: Plan | null = null;
let lastFolder: vscode.WorkspaceFolder | null = null;
let lastFailuresBrief: string | null = null;
let history: { role: "user" | "model"; text: string }[] = [];

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

  async function runPlan(plan: Plan, folder: vscode.WorkspaceFolder) {
    chatProvider.post({ type: "ops", running: true, canRepair: !!lastFailuresBrief });

    out.show(true);
    out.appendLine(`Goal: ${plan.goal}`);
    out.appendLine(`Root: ${plan.root}`);

    try {
      const { results, tree } = await executePlan(plan, folder, out);
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;

      lastFailuresBrief =
        failed === 0
          ? null
          : results
              .filter((r) => !r.ok)
              .map((r) => `- ${r.step}: ${"error" in r ? r.error : ""}`)
              .join("\n");

      const summary =
        `▶️ Executed ${results.length} steps — OK: ${ok}, Failed: ${failed}\n\n` +
        (failed ? `Failures:\n${lastFailuresBrief}\n\n` : "") +
        `File tree (first 5):\n${tree.slice(0, 5).join("\n")}`;

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
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "myCursor"
      );
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
          // Leave it to user to click Run
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
          chatProvider.post({ type: "status", message: `Generating repair plan (attempt ${attempts}/${maxRepairAttempts})…` });
          const repairPlan = await generateRepairPlan(context, lastFailuresBrief, contextBrief, history);

          history.push({ role: "user", text: `[auto-repair attempt ${attempts}] ${lastFailuresBrief}` });
          history.push({ role: "model", text: JSON.stringify(repairPlan) });
          await maybeSaveHistory();

          lastPlan = repairPlan;
          chatProvider.post({ type: "model", text: `🛠️ Repair plan:\n${JSON.stringify(repairPlan, null, 2)}` });

          await runPlan(repairPlan, lastFolder);
        }
      } catch (e: any) {
        chatProvider.post({ type: "error", message: `My Cursor error: ${e.message}` });
      }
    }
  };

  context.subscriptions.push(out);
}

export function deactivate() {}
