// src/ui/planPanel.ts
import * as vscode from "vscode";
import { Plan } from "../engine/plan";
export class PlanPanel {
  public static show(plan: Plan): void {
    const panel = vscode.window.createWebviewPanel(
      "myCursor.plan",
      "My Cursor — Plan Preview",
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );
    panel.webview.html = PlanPanel.html(plan);
  }

  private static html(plan: Plan): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    const steps = plan.steps.map((s, i) =>
      `<li><code>${esc(s.action)}</code> ${esc(JSON.stringify({...s, action: undefined}))}</li>`
    ).join("\n");
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><link rel="stylesheet" href="${"vscode-resource:/"}../media/plan.css"></head>
<body>
  <h1>Plan Preview</h1>
  <p><b>Goal:</b> ${esc(plan.goal)}</p>
  <p><b>Root:</b> <code>${esc(plan.root)}</code></p>
  <ol>${steps}</ol>
  <p style="opacity:.7">Use the command palette action to Run/Cancel. This panel is read-only.</p>
</body>
</html>`;
  }
}
