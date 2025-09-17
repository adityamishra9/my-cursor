// api/generate.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

/** Basic CORS (optional). Lock this down to specific origins if needed. */
function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

const PROVIDERS = {
  gemini: {
    keyEnv: "GEMINI_API_KEY",
    // Gemini: key goes in the query string
    endpoint: (model: string, apiKey: string) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  },
  openai: {
    keyEnv: "OPENAI_API_KEY",
    endpoint: () => "https://api.openai.com/v1/chat/completions"
  },
  anthropic: {
    keyEnv: "ANTHROPIC_API_KEY",
    endpoint: () => "https://api.anthropic.com/v1/messages"
  }
} as const;

function getEnvOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Convert neutral messages -> Gemini "contents" + optional systemInstruction */
function toGeminiPayload(messages: Msg[], temperature: number, responseMimeType?: string) {
  const systemParts: string[] = [];
  const contents = messages
    .filter(Boolean)
    .map((m) => {
      if (m.role === "system") {
        systemParts.push(m.content);
        return null;
      }
      const role = m.role === "assistant" ? "model" : "user"; // map assistant->model
      return { role, parts: [{ text: m.content }] };
    })
    .filter(Boolean);

  const payload: any = {
    contents,
    generationConfig: {
      temperature,
      ...(responseMimeType ? { responseMimeType } : {})
    }
  };

  if (systemParts.length) {
    payload.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }
  return payload;
}

/** Convert neutral messages -> OpenAI Chat Completions body */
function toOpenAIChatPayload(messages: Msg[], temperature: number, model: string) {
  return {
    model,
    temperature,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content
    }))
  };
}

/** Convert neutral messages -> Anthropic Messages API body */
function toAnthropicPayload(messages: Msg[], temperature: number, model: string) {
  // Anthropic separates system vs messages (user/assistant alternation)
  const system = messages.find((m) => m.role === "system")?.content || undefined;
  const chat = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content
    }));

  return {
    model,
    temperature,
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: chat
  };
}

function extractOutput(provider: string, data: any): string {
  try {
    if (provider === "gemini") {
      // data.candidates[0].content.parts[0].text
      return (
        data?.candidates?.[0]?.content?.parts?.[0]?.text ??
        data?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data ??
        ""
      );
    }
    if (provider === "openai") {
      // data.choices[0].message.content
      return data?.choices?.[0]?.message?.content ?? "";
    }
    if (provider === "anthropic") {
      // data.content[0].text
      const blocks = data?.content;
      if (Array.isArray(blocks) && blocks.length > 0) {
        const first = blocks[0];
        // Can be {type:"text", text:"..."} or other block types
        if (typeof first?.text === "string") return first.text;
      }
      return "";
    }
  } catch {
    // fallthrough
  }
  return "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      provider = "gemini",
      model = provider === "openai" ? "gpt-4o" : provider === "anthropic" ? "claude-3-5-sonnet-20240620" : "gemini-2.0-flash",
      temperature = 0.2,
      messages = [],
      response_mime_type
    } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] required" });
    }

    if (!(provider in PROVIDERS)) {
      return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }

    const { keyEnv, endpoint } = (PROVIDERS as any)[provider];
    const key = getEnvOrThrow(keyEnv);

    let url = "";
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: any = {};

    if (provider === "gemini") {
      url = endpoint(model, key);
      body = toGeminiPayload(messages, temperature, response_mime_type);
      // Gemini key is passed via query param; no Authorization header needed
    } else if (provider === "openai") {
      url = endpoint();
      headers.Authorization = `Bearer ${key}`;
      body = toOpenAIChatPayload(messages, temperature, model);
    } else if (provider === "anthropic") {
      url = endpoint();
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      body = toAnthropicPayload(messages, temperature, model);
    }

    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "upstream_error", provider, model, data });
    }

    const output = extractOutput(provider, data);
    return res.status(200).json({ provider, model, output, raw: data });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
}


// Req body
// {
//   "provider": "gemini",
//   "model": "gemini-2.0-flash",
//   "temperature": 0.2,
//   "messages": [
//     {"role":"system","content":"You are a precise planner..."},
//     {"role":"user","content":"Build a Next.js + Tailwind app"}
//   ],
//   "response_mime_type": "application/json"
// }
