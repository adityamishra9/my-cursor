// src/ui/planPanel.ts
import * as vscode from "vscode";
import { Plan } from "../engine/plan";

export class PlanPanel {
  public static show(plan: Plan): void {
    const panel = vscode.window.createWebviewPanel(
      "myCursor.plan",
      "My Cursor — Plan Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: false,
        enableCommandUris: true
      }
    );
    panel.webview.html = PlanPanel.html(plan);
  }

  private static html(plan: Plan): string {
    const esc = (s: string) =>
      s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

    const steps = plan.steps
      .map(
        (s) =>
          `<li><code>${esc(s.action)}</code> ${esc(
            JSON.stringify({ ...s, action: undefined })
          )}</li>`
      )
      .join("\n");

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${"vscode-resource:/"}../media/plan.css">
  <style>
    /* minimal inline styles for the Run button */
    .bar { display:flex; gap:8px; align-items:center; margin-bottom:12px; }
    .btn {
      display:inline-block; text-decoration:none; padding:6px 12px; border-radius:6px;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .meta { opacity:.85; }
  </style>
</head>
<body>
  <div class="bar">
    <a class="btn" href="command:my-cursor.runPlanNow">Run Plan</a>
    <span class="meta">Goal: <b>${esc(plan.goal)}</b> &nbsp;•&nbsp; Root: <code>${esc(plan.root)}</code></span>
  </div>

  <h1>Plan Preview</h1>
  <ol>${steps}</ol>
  <p class="meta">Click <b>Run Plan</b> above or use the bottom-right notification. This panel is read-only.</p>
</body>
</html>`;
  }
}
