// src/engine/gemini.ts
import * as vscode from "vscode";
import type { Plan } from "./plan";

/** ---- Settings helpers ---- */
const PROVIDERS = new Set(["gemini", "openai", "anthropic"] as const);
const DEFAULT_MODELS: Record<string, string> = {
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-20240620",
};

function getCfg() {
  const cfg = vscode.workspace.getConfiguration("myCursor");
  const rawProvider = (cfg.get<string>("provider", "gemini") || "gemini").toLowerCase();
  const provider = (new Set(["gemini", "openai", "anthropic"]) as Set<string>).has(rawProvider)
    ? rawProvider
    : "gemini";

  const modelSetting = cfg.get<string>("model", "") || "";
  const model =
    modelSetting.trim() ||
    (provider === "openai"
      ? "gpt-4o"
      : provider === "anthropic"
      ? "claude-3-5-sonnet-20240620"
      : "gemini-2.0-flash");

  return {
    provider,
    model,
    temperature: cfg.get<number>("temperature", 0.2),
    apiProxyUrl: cfg.get<string>("apiProxyUrl", "https://cursor.adityamishra.tech/api/generate"),
  };
}

/** ---- System Prompts ---- */
const SYSTEM_PROMPT = `
You are a precise project-automation planner for a VS Code workspace.
You NEVER output anything except a single JSON object matching this schema:

{
  "goal": "string (one-line summary of what you'll do)",
  "root": "string (relative path under the workspace where changes occur, e.g. \".\", \"my-app\")",
  "steps": [
    {"action":"mkdir","path":"relative/dir/path"},
    {"action":"write","path":"relative/file","content":"full file content"},
    {"action":"append","path":"relative/file","content":"content to append"},
    {"action":"edit","path":"relative/file","find":"text or /regex/gi","replace":"replacement text"},
    {"action":"shell","cmd":"string","cwd":"relative/dir (optional)"},
    {"action":"install","packages":["pkg1","pkg2"],"dev":false,"cwd":"relative/dir (optional)"}
  ]
}

Rules:
- Keep all paths RELATIVE to the workspace root.
- Prefer minimal, correct steps; avoid redundant mkdir when write creates dirs.
- For JS/TS/Next/Tailwind projects, include a working package.json if you don't run a framework init.
- If unsure, choose sane defaults and produce a runnable app.
- Do NOT include explanations, markdown, or backticks — ONLY raw JSON.
`.trim();

const REPAIR_SYSTEM_PROMPT = `
You are generating a TARGETED REPAIR PLAN to fix failures from a previous attempt.
Output ONLY a single JSON object of the same schema as above.

Constraints:
- Focus ONLY on steps required to resolve the reported failures.
- Avoid repeating successful steps unless necessary (e.g., idempotent edits/writes with guards).
- Respect workspace trust and safety; all paths must remain within the workspace.
- If a file to edit may not exist, ensure you create it first (write) or guard the edit accordingly.
- Keep the plan minimal and ordered so it can be applied immediately.
- No prose, markdown, or comments — ONLY the JSON object.
`.trim();

/** ---- Utilities ---- */
function parsePlanText(txt: string): Plan {
  const cleaned = txt.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return normalizePlan(JSON.parse(cleaned));
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last >= 0) {
      return normalizePlan(JSON.parse(cleaned.slice(first, last + 1)));
    }
    throw new Error("Failed to parse JSON plan from model output.");
  }
}

function normalizePlan(p: any): Plan {
  return {
    goal: String(p?.goal ?? ""),
    root: String(p?.root ?? "."),
    steps: Array.isArray(p?.steps) ? p.steps : [],
  };
}

function buildMessages(
  system: string,
  userRequest: string,
  history: { role: "user" | "model"; text: string }[],
) {
  const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  msgs.push({ role: "system", content: system });
  for (const m of history) {
    msgs.push({
      role: m.role === "model" ? "assistant" : "user",
      content: String(m.text ?? ""),
    });
  }
  msgs.push({ role: "user", content: userRequest });
  return msgs;
}

/** ---- Public API (proxy-only) ---- */
export async function generatePlan(
  _context: vscode.ExtensionContext,
  userRequest: string,
  history: { role: "user" | "model"; text: string }[]
): Promise<Plan> {
  const { provider, model, temperature, apiProxyUrl } = getCfg();
  const messages = buildMessages(SYSTEM_PROMPT, userRequest, history);

  if (!apiProxyUrl?.trim()) {
    throw new Error("Missing proxy URL. Set `myCursor.apiProxyUrl` in settings.");
  }

  const firstTry = await callProxy(apiProxyUrl, provider, model, temperature, messages);
  if (firstTry.ok) return parsePlanText(firstTry.output);

  if (provider !== "gemini") {
    const fallback = await callProxy(apiProxyUrl, "gemini", DEFAULT_MODELS.gemini, temperature, messages);
    if (fallback.ok) return parsePlanText(fallback.output);
  }
  throw new Error(firstTry.error || "Proxy call failed.");
}

/**
 * Ask the model for a targeted repair plan.
 * @param failureBrief A compact text containing failed steps + errors.
 * @param contextBrief Extra context: prior goal, root, partial file tree, etc.
 */
export async function generateRepairPlan(
  _context: vscode.ExtensionContext,
  failureBrief: string,
  contextBrief: string,
  history: { role: "user" | "model"; text: string }[]
): Promise<Plan> {
  const { provider, model, temperature, apiProxyUrl } = getCfg();
  const userMsg =
    `Previous attempt failed. Please produce a MINIMAL repair plan as per schema.\n\n` +
    `--- Failures ---\n${failureBrief}\n\n--- Context ---\n${contextBrief}`;
  const messages = buildMessages(REPAIR_SYSTEM_PROMPT, userMsg, history);

  const firstTry = await callProxy(apiProxyUrl, provider, model, temperature, messages);
  if (firstTry.ok) return parsePlanText(firstTry.output);

  if (provider !== "gemini") {
    const fallback = await callProxy(apiProxyUrl, "gemini", DEFAULT_MODELS.gemini, temperature, messages);
    if (fallback.ok) return parsePlanText(fallback.output);
  }
  throw new Error(firstTry.error || "Proxy call (repair) failed.");
}

/** ---- Proxy call helper ---- */
async function callProxy(
  url: string,
  provider: string,
  model: string,
  temperature: number,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        model,
        temperature,
        messages,
        response_mime_type: "application/json",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Proxy error ${res.status}: ${text.slice(0, 1000)}` };
    }

    const data: any = await res.json();
    const output = String(data?.output ?? "");
    if (!output.trim()) {
      return { ok: false, error: "Empty output from proxy." };
    }
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
