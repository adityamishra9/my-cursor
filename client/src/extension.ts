// src/extension.ts
import * as vscode from "vscode";
import { generatePlan, generateRepairPlan } from "./engine/gemini";
import { executePlan } from "./engine/executor";
import { PlanPanel } from "./ui/planPanel";
import type { Plan } from "./engine/plan";

let lastPlan: Plan | null = null;
let lastFolder: vscode.WorkspaceFolder | null = null;
let lastFailuresBrief: string | null = null;

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
      autoRepair: cfg.get<boolean>("autoRepair", true),
      maxRepairAttempts: cfg.get<number>("maxRepairAttempts", 2),
    };
  }

  async function maybeSaveHistory() {
    const { persistHistory } = getExtCfg();
    if (persistHistory) {
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

  // Shared runner used by commands
  async function runPlan(plan: Plan, folder: vscode.WorkspaceFolder) {
    out.show(true);
    out.appendLine(`Goal: ${plan.goal}`);
    out.appendLine(`Root: ${plan.root}`);

    try {
      const { results, tree } = await executePlan(plan, folder, out);

      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;

      out.appendLine(`Done. OK: ${ok}, Failed: ${failed}`);
      for (const r of results) {
        if (!r.ok) out.appendLine(`  ❌ ${r.step}: ${r.error}`);
      }

      out.appendLine("\nFile tree after run:");
      for (const t of tree) out.appendLine("  " + t);

      // Prepare a compact failure brief for loopback
      lastFailuresBrief =
        failed === 0
          ? null
          : results
              .filter((r) => !r.ok)
              .map((r) => `- ${r.step}: ${"error" in r ? r.error : ""}`)
              .join("\n");

      vscode.window.showInformationMessage(
        `My Cursor: ${ok} steps OK, ${failed} failed. See “My Cursor” output.`
      );

      return { failed, treePreview: tree.slice(0, 150).join("\n") };
    } catch (e: any) {
      const msg = `My Cursor error (execute): ${e.message}`;
      out.appendLine(msg);
      lastFailuresBrief = `- runtime exception: ${e.message}`;
      vscode.window.showErrorMessage(msg);
      return { failed: 1, treePreview: "" };
    }
  }

  // Hidden command invoked by the webview's command URI
  const cmdRunPlanNow = vscode.commands.registerCommand(
    "my-cursor.runPlanNow",
    async () => {
      if (!lastPlan || !lastFolder) {
        vscode.window.showWarningMessage(
          "No plan ready to run. Generate a plan first (My Cursor: Plan & Run)."
        );
        return;
      }
      await runPlan(lastPlan, lastFolder);
    }
  );

  const cmdRepairLast = vscode.commands.registerCommand(
    "my-cursor.repairLast",
    async () => {
      const { autoRun } = getExtCfg();
      if (!lastFolder) {
        vscode.window.showWarningMessage("No previous run context.");
        return;
      }
      if (!lastFailuresBrief) {
        vscode.window.showInformationMessage("No failures to repair.");
        return;
      }

      const contextBrief =
        (lastPlan
          ? `previous goal: ${lastPlan.goal}\nroot: ${lastPlan.root}\n`
          : "") + `workspace: ${lastFolder.uri.fsPath}`;

      try {
        const repair = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Generating repair plan…" },
          () => generateRepairPlan(context, lastFailuresBrief!, contextBrief, history)
        );

        history.push({ role: "user", text: "[repair] " + lastFailuresBrief });
        history.push({ role: "model", text: JSON.stringify(repair) });
        await maybeSaveHistory();

        lastPlan = repair; // allow re-run via button
        PlanPanel.show(repair);

        if (autoRun) {
          await runPlan(repair, lastFolder);
        } else {
          const choice = await vscode.window.showInformationMessage(
            "Repair plan generated. Run it?",
            "Run Repair",
            "Dismiss"
          );
          if (choice === "Run Repair") {
            await runPlan(repair, lastFolder);
          }
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Repair failed: ${e.message}`);
      }
    }
  );

  // --- commands ---
  const cmdClearHistory = vscode.commands.registerCommand(
    "my-cursor.clearHistory",
    async () => {
      history = [];
      await context.globalState.update(stateKey, []);
      vscode.window.showInformationMessage("My Cursor: History cleared.");
    }
  );

  const cmdPlan = vscode.commands.registerCommand("my-cursor.plan", async () => {
    const folder = await pickWorkspaceFolder();
    if (!folder) {
      vscode.window.showErrorMessage("Open a folder (or select one) to run My Cursor.");
      return;
    }

    const req = await vscode.window.showInputBox({
      title: "What should I build?",
      prompt: "Describe your request (e.g., 'Scaffold Next.js + Tailwind + /api/todos').",
      ignoreFocusOut: true,
    });
    if (!req) return;

    try {
      // ✅ Only the model call is wrapped in progress.
      const plan = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Generating plan…",
        },
        () => generatePlan(context, req, history)
      );

      // After progress finishes, do the rest (so the spinner goes away)
      history.push({ role: "user", text: req });
      history.push({ role: "model", text: JSON.stringify(plan) });
      await maybeSaveHistory();

      // Track for "Run Plan" command
      lastPlan = plan;
      lastFolder = folder;

      // Show preview
      PlanPanel.show(plan);

      const { autoRun, autoRepair, maxRepairAttempts } = getExtCfg();

      // Prompt to run (or autorun)
      let proceed = autoRun;
      if (!autoRun) {
        const choice = await vscode.window.showInformationMessage(
          "Plan generated. Review in the Plan Preview. Proceed to execute?",
          "Run",
          "Dismiss"
        );
        proceed = choice === "Run";
      }

      if (!proceed) {
        out.appendLine("User dismissed run notification.");
        return;
      }

      // Execute with optional auto-repair loop
      let attempts = 0;
      let runResult = await runPlan(plan, folder);

      while (autoRepair && runResult.failed > 0 && attempts < maxRepairAttempts) {
        attempts++;
        if (!lastFailuresBrief) break;

        const contextBrief =
          `previous goal: ${plan.goal}\nroot: ${plan.root}\n` +
          `tree (truncated):\n${runResult.treePreview}\nworkspace: ${folder.uri.fsPath}`;

        const repairPlan = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Generating repair plan (attempt ${attempts}/${maxRepairAttempts})…`,
          },
          () => generateRepairPlan(context, lastFailuresBrief!, contextBrief, history)
        );

        history.push({ role: "user", text: `[auto-repair attempt ${attempts}] ${lastFailuresBrief}` });
        history.push({ role: "model", text: JSON.stringify(repairPlan) });
        await maybeSaveHistory();

        lastPlan = repairPlan;
        PlanPanel.show(repairPlan);

        // autorun repair
        runResult = await runPlan(repairPlan, folder);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`My Cursor error: ${e.message}`);
    }
  });

  context.subscriptions.push(cmdRunPlanNow, cmdRepairLast, cmdClearHistory, cmdPlan, out);
}

export function deactivate() {}
