// src/extension.ts
import * as vscode from "vscode";
import { generatePlan, setApiKey, clearApiKey } from "./engine/gemini";
import { executePlan } from "./engine/executor";
import { PlanPanel } from "./ui/planPanel";

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("My Cursor");

  // --- persistent history (last 50 turns) ---
  const stateKey = "my-cursor.history";
  const loaded =
    context.globalState.get<{ role: "user" | "model"; text: string }[]>(
      stateKey
    ) ?? [];
  let history: { role: "user" | "model"; text: string }[] = loaded;

  function getExtCfg() {
    const cfg = vscode.workspace.getConfiguration("myCursor");
    return {
      autoRun: cfg.get<boolean>("autoRun", false),
      persistHistory: cfg.get<boolean>("persistHistory", true),
    };
  }

  async function maybeSaveHistory() {
    const { persistHistory } = getExtCfg();
    if (persistHistory) {
      // keep last 50 messages (user/model pairs)
      await context.globalState.update(stateKey, history.slice(-50));
    }
  }

  // --- multi-root: ask user which folder to use ---
  async function pickWorkspaceFolder(): Promise<
    vscode.WorkspaceFolder | undefined
  > {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    if (folders.length === 1) return folders[0];

    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })),
      { title: "Select workspace folder for My Cursor" }
    );
    return pick?.f;
  }

  // --- commands ---
  const cmdConfigure = vscode.commands.registerCommand(
    "my-cursor.configure",
    async () => {
      await setApiKey(context);
    }
  );

  const cmdClearKey = vscode.commands.registerCommand(
    "my-cursor.clearKey",
    async () => {
      await clearApiKey(context);
      vscode.window.showInformationMessage("Gemini API key cleared.");
    }
  );

  const cmdClearHistory = vscode.commands.registerCommand(
    "my-cursor.clearHistory",
    async () => {
      history = [];
      await context.globalState.update(stateKey, []);
      vscode.window.showInformationMessage("My Cursor: history cleared.");
    }
  );

  const cmdToggleDryRun = vscode.commands.registerCommand(
    "my-cursor.toggleDryRun",
    async () => {
      const cfg = vscode.workspace.getConfiguration("myCursor");
      const current = cfg.get<boolean>("dryRun", true);
      await cfg.update("dryRun", !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `Dry Run is now ${!current ? "ON" : "OFF"}.`
      );
    }
  );

  const cmdPlan = vscode.commands.registerCommand(
    "my-cursor.plan",
    async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage(
          "Open a folder (or select one) to run My Cursor."
        );
        return;
      }

      const req = await vscode.window.showInputBox({
        title: "What should I build?",
        prompt:
          "Describe your request (e.g., 'Scaffold Next.js + Tailwind + /api/todos').",
        ignoreFocusOut: true,
      });
      if (!req) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Generating plan…",
          },
          async () => {
            const plan = await generatePlan(context, req, history);
            history.push({ role: "user", text: req });
            history.push({ role: "model", text: JSON.stringify(plan) });
            await maybeSaveHistory();

            // Preview
            PlanPanel.show(plan);

            // Auto-run toggle
            const { autoRun } = getExtCfg();
            let proceed = autoRun;
            if (!autoRun) {
              const choice = await vscode.window.showInformationMessage(
                "Plan generated. Review in the preview panel. Proceed to execute?",
                { modal: true },
                "Run",
                "Cancel"
              );
              proceed = choice === "Run";
            }
            if (!proceed) {
              out.appendLine("User cancelled plan execution.");
              return;
            }

            // Execute
            out.show(true);
            out.appendLine(`Goal: ${plan.goal}`);
            out.appendLine(`Root: ${plan.root}`);
            const { results, tree } = await executePlan(plan, folder, out);

            const ok = results.filter((r) => r.ok).length;
            const failed = results.length - ok;
            out.appendLine(`Done. OK: ${ok}, Failed: ${failed}`);
            for (const r of results) {
              if (!r.ok) out.appendLine(`  ❌ ${r.step}: ${r.error}`);
            }

            out.appendLine("\nFile tree after run:");
            for (const t of tree) out.appendLine("  " + t);

            vscode.window.showInformationMessage(
              `My Cursor: ${ok} steps OK, ${failed} failed. See “My Cursor” output.`
            );
          }
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`My Cursor error: ${e.message}`);
      }
    }
  );

  context.subscriptions.push(
    cmdConfigure,
    cmdClearKey,
    cmdClearHistory,
    cmdToggleDryRun,
    cmdPlan,
    out
  );
}

export function deactivate() {}
