// src/engine/gemini.ts
import * as vscode from "vscode";
import { coerceJsonToPlan, Plan } from "./plan";

const SECRET_KEY = "my-cursor.geminiApiKey";

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("myCursor");
  return {
    model: cfg.get<string>("model", "gemini-2.0-flash"),
    temperature: cfg.get<number>("temperature", 0.2),
  };
}

async function ensureApiKey(context: vscode.ExtensionContext): Promise<string> {
  // Prefer SecretStorage; fallback to env if present
  let apiKey = await context.secrets.get(SECRET_KEY);
  if (apiKey) return apiKey;

  if (process.env.GEMINI_API_KEY) {
    // Offer to import env var into secret storage
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
    prompt: "Your key will be stored securely in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v: any) => (v.trim() ? null : "API key required"),
  });
  if (!entered) throw new Error("No API key provided.");
  await context.secrets.store(SECRET_KEY, entered.trim());
  return entered.trim();
}

export async function clearApiKey(context: vscode.ExtensionContext) {
  await context.secrets.delete(SECRET_KEY);
}

export async function setApiKey(context: vscode.ExtensionContext) {
  await ensureApiKey(context);
  vscode.window.showInformationMessage("Gemini API key saved.");
}

// We use global fetch (Node 18+ in VS Code). If unavailable, advise user.
function assertFetchAvailable() {
  if (typeof fetch !== "function") {
    throw new Error(
      "Global fetch is not available in this VS Code runtime. Please update VS Code to a recent version."
    );
  }
}

export async function generatePlan(
  context: vscode.ExtensionContext,
  userRequest: string,
  history: { role: "user" | "model"; text: string }[]
): Promise<Plan> {
  assertFetchAvailable();
  const apiKey = await ensureApiKey(context);
  const { model, temperature } = getConfig();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const SYSTEM_PROMPT = `
You are a precise project-automation planner for a VS Code workspace.
You NEVER output anything except a single JSON object matching this schema:

{
  "goal": "string",
  "root": "string",
  "steps": [
    {"action":"mkdir","path":"..."},
    {"action":"write","path":"...","content":"..."},
    {"action":"append","path":"...","content":"..."},
    {"action":"edit","path":"...","find":"text or /regex/gi","replace":"..."},
    {"action":"shell","cmd":"...","cwd":"optional"},
    {"action":"install","packages":["pkg"],"dev":false,"cwd":"optional"}
  ]
}

Rules:
- Paths must be RELATIVE to the workspace root.
- Prefer minimal, correct steps; avoid redundant mkdir when write creates dirs.
- For JS/TS/Next/Tailwind projects, either use \`npx create-next-app@latest\` or scaffold + proper package.json + scripts.
- If unsure, choose sane defaults and produce a runnable app.
- Output ONLY raw JSON. No markdown, no backticks.
`.trim();

  const contents: any[] = [];
  for (const m of history) {
    contents.push({ role: m.role, parts: [{ text: m.text }] });
  }
  contents.push({ role: "user", parts: [{ text: userRequest }] });

  const body = {
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini error ${res.status}: ${t.slice(0, 800)}`);
  }
  const data: any = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    data?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data;

  if (!text) throw new Error("No response text from Gemini.");
  return coerceJsonToPlan(String(text));
}
