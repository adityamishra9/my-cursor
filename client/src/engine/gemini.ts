// src/engine/gemini.ts
import * as vscode from "vscode";
import type { Plan } from "./plan";

/** ---- Settings helpers ---- */
const SECRET_KEY = "my-cursor.geminiApiKey";
const PROVIDERS = new Set(["gemini", "openai", "anthropic"] as const);
const DEFAULT_MODELS: Record<string, string> = {
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-20240620"
};

function getCfg() {
  const cfg = vscode.workspace.getConfiguration("myCursor");
  const rawProvider = (cfg.get<string>("provider", "gemini") || "gemini").toLowerCase();
  const provider = PROVIDERS.has(rawProvider as any) ? rawProvider : "gemini";

  const modelSetting = cfg.get<string>("model", "") || "";
  const model = (modelSetting.trim() || DEFAULT_MODELS[provider]) as string;

  return {
    provider,
    model,
    temperature: cfg.get<number>("temperature", 0.2),
    apiProxyUrl: cfg.get<string>("apiProxyUrl", "") || "",
    embeddedKey: cfg.get<string>("embeddedApiKey", "") || ""
  };
}

/** ---- System Prompt (strict plan schema) ---- */
const SYSTEM_PROMPT = `
You are a precise project-automation planner for a VS Code workspace.
You NEVER output anything except a single JSON object matching this schema:

{
  "goal": "string (one-line summary of what you'll do)",
  "root": "string (relative path under the workspace where changes occur, e.g. \\".\\", \\"my-app\\")",
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
    steps: Array.isArray(p?.steps) ? p.steps : []
  };
}

function buildMessages(
  userRequest: string,
  history: { role: "user" | "model"; text: string }[]
) {
  const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  msgs.push({ role: "system", content: SYSTEM_PROMPT });
  for (const m of history) {
    msgs.push({
      role: m.role === "model" ? "assistant" : "user",
      content: String(m.text ?? "")
    });
  }
  msgs.push({ role: "user", content: userRequest });
  return msgs;
}

/** ---- Public API ---- */
export async function generatePlan(
  context: vscode.ExtensionContext,
  userRequest: string,
  history: { role: "user" | "model"; text: string }[]
): Promise<Plan> {
  const { provider, model, temperature, apiProxyUrl } = getCfg();
  const messages = buildMessages(userRequest, history);

  if (apiProxyUrl) {
    // Primary path: your proxy. If non-gemini fails, auto-fallback to gemini once.
    const firstTry = await callProxy(apiProxyUrl, provider, model, temperature, messages);
    if (firstTry.ok) return parsePlanText(firstTry.output);

    if (provider !== "gemini") {
      const fallback = await callProxy(apiProxyUrl, "gemini", DEFAULT_MODELS.gemini, temperature, messages);
      if (fallback.ok) return parsePlanText(fallback.output);
    }
    // Neither worked
    throw new Error(firstTry.error || "Proxy call failed.");
  }

  // Fallback: direct Gemini (dev/local use)
  return generatePlanDirectGemini(context, userRequest, history);
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
        response_mime_type: "application/json"
      })
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

/** ---- Direct-to-Gemini (no proxy) ---- */
async function ensureApiKey(context: vscode.ExtensionContext): Promise<string> {
  const { embeddedKey } = getCfg();
  if (embeddedKey?.trim()) return embeddedKey.trim();

  const existing = await context.secrets.get(SECRET_KEY);
  if (existing) return existing;

  if (process.env.GEMINI_API_KEY) {
    const useEnv = await vscode.window.showInformationMessage(
      "GEMINI_API_KEY found in environment. Store it securely in VS Code?",
      "Store",
      "Skip"
    );
    if (useEnv === "Store") {
      await context.secrets.store(SECRET_KEY, process.env.GEMINI_API_KEY);
      return process.env.GEMINI_API_KEY;
    }
    return process.env.GEMINI_API_KEY;
  }

  const entered = await vscode.window.showInputBox({
    title: "Enter Gemini API Key",
    prompt: "Stored securely in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : "API key required")
  });
  if (!entered) throw new Error("No API key provided.");
  await context.secrets.store(SECRET_KEY, entered.trim());
  return entered.trim();
}

async function generatePlanDirectGemini(
  context: vscode.ExtensionContext,
  userRequest: string,
  history: { role: "user" | "model"; text: string }[]
): Promise<Plan> {
  const { model, temperature } = getCfg();
  const apiKey = await ensureApiKey(context);

  const contents: any[] = [];
  contents.push({ role: "user", parts: [{ text: SYSTEM_PROMPT }] }); // simple systemInstruction fallback
  for (const m of history) {
    contents.push({
      role: m.role === "model" ? "model" : "user",
      parts: [{ text: m.text }]
    });
  }
  contents.push({ role: "user", parts: [{ text: userRequest }] });

  const body = {
    contents,
    generationConfig: { temperature, responseMimeType: "application/json" }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini error ${res.status}: ${t.slice(0, 1000)}`);
  }
  const data: any = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    data?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data;

  if (!text) throw new Error("No response text from Gemini.");
  return parsePlanText(String(text));
}

/** ---- Configure/Clear commands (kept for UX parity) ---- */
export async function setApiKey(context: vscode.ExtensionContext) {
  const entered = await vscode.window.showInputBox({
    title: "Set Gemini API Key",
    prompt: "Stored securely in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true
  });
  if (!entered) return;
  await context.secrets.store(SECRET_KEY, entered.trim());
  vscode.window.showInformationMessage("Gemini API key saved.");
}

export async function clearApiKey(context: vscode.ExtensionContext) {
  await context.secrets.delete(SECRET_KEY);
}
