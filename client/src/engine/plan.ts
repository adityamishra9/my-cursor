// src/engine/plan.ts
export type PlanAction =
  | { action: "mkdir"; path: string }
  | { action: "write"; path: string; content?: string }
  | { action: "append"; path: string; content?: string }
  | { action: "edit"; path: string; find: string; replace?: string }
  | { action: "shell"; cmd: string; cwd?: string }
  | { action: "install"; packages: string[]; dev?: boolean; cwd?: string };

export interface Plan {
  goal: string;
  root: string; // "." or subfolder
  steps: PlanAction[];
}

export function coerceJsonToPlan(raw: string): Plan {
  // Strip ```json fences if present
  const cleaned = raw.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  // Try whole string, then largest {...} slice
  let obj: any;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last >= 0) {
      obj = JSON.parse(cleaned.slice(first, last + 1));
    } else {
      throw new Error("Failed to parse JSON plan from model response.");
    }
  }

  // Minimal validation + defaults
  const plan: Plan = {
    goal: typeof obj.goal === "string" ? obj.goal : "(no summary)",
    root: typeof obj.root === "string" && obj.root.trim() ? obj.root.trim() : ".",
    steps: Array.isArray(obj.steps) ? obj.steps : [],
  };

  // Only allow known actions
  plan.steps = plan.steps.filter((s: any) =>
    ["mkdir","write","append","edit","shell","install"].includes(s?.action)
  );

  return plan;
}
