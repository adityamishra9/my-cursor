# My Cursor — VS Code Agent (Plan → Preview → Execute)

Turn natural language into **safe, reviewable workspace changes**. This repo contains:

- **client/** — a VS Code extension that generates a JSON **plan** with file ops (mkdir/write/append/edit), optional **shell** and **install** steps, lets you **preview**, and (optionally) **execute** it.
- **server/** — a minimal **proxy API** you can deploy (e.g. to Vercel) that forwards requests to **Gemini / OpenAI / Anthropic** with a common request format.

> ✨ Default provider is **Gemini** with `gemini-2.0-flash`. You can switch to OpenAI or Anthropic from settings. All writes are **blocked** by default (Dry Run ON).

---

## Demo (How it works)

1. Run the **My Cursor: Plan & Run** command.
2. Describe what you want (e.g. _“Scaffold a Next.js app with Tailwind and a /api/todos endpoint.”_).
3. The extension asks your LLM (via your **proxy** by default) to return **only a JSON plan**.
4. You review the **Plan Preview** (read‑only webview).
5. If you choose **Run**, the extension executes the steps in your workspace (still respecting Dry Run if enabled).

---

## Repo Layout

```
.
├── .gitignore
├── client/                  # VS Code extension
│   ├── .vscode/             # Debug config for local development
│   │   ├── launch.json
│   │   └── tasks.json
│   ├── .vscodeignore        # Files excluded from packaged .vsix
│   ├── media/
│   │   └── plan.css         # Styling for plan preview webview
│   ├── package.json         # Extension manifest & scripts
│   ├── src/
│   │   ├── engine/
│   │   │   ├── executor.ts  # Executes plan steps (safe file ops, shell/install behind flags)
│   │   │   ├── fileTree.ts  # Utility to compute workspace file tree
│   │   │   ├── gemini.ts    # Provider routing (proxy first, direct Gemini fallback) + system prompt
│   │   │   ├── plan.ts      # Plan type & coercion
│   │   │   └── sanitize.ts  # Workspace trust / path guards
│   │   ├── extension.ts     # Activation, commands, state/history, UI wiring
│   │   └── ui/
│   │       └── planPanel.ts # Read‑only plan preview webview
│   └── tsconfig.json
└── server/                  # Minimal proxy (Vercel serverless)
    ├── api/
    │   └── generate.ts      # POST /api/generate (Gemini/OpenAI/Anthropic)
    ├── package.json
    └── tsconfig.json
```

---

## Quick Start

### Prerequisites
- **Node.js 20+**
- **VS Code 1.104+**
- (Recommended) A deployment of the **proxy** in `server/` with at least one provider API key set.

### 1) Run the proxy locally (optional, but recommended)

The extension first tries `myCursor.apiProxyUrl` (defaults to `https://cursor.adityamishra.tech/api/generate`). You can point it to your own instance.

```bash
cd server
npm i
# For local dev with Vercel:
npx vercel dev
# This serves POST /api/generate at http://localhost:3000/api/generate
```

Set **env vars** for your chosen provider(s) before `vercel dev` (or in your Vercel project settings if deploying):

- `GEMINI_API_KEY` — Google Generative Language key
- `OPENAI_API_KEY` — OpenAI key
- `ANTHROPIC_API_KEY` — Anthropic key

> The proxy normalizes messages and returns `output` (string). For Gemini it also supports `response_mime_type: "application/json"` so models emit **raw JSON** plans.

### 2) Build & debug the VS Code extension

```bash
cd client
npm i
npm run build
# Press F5 in VS Code to "Run Extension" (launch.json included)
```

In the **Extension Development Host**:

- Run **command**: **“My Cursor: Plan & Run”**
- Enter your request
- Inspect the **Plan Preview**
- Choose **Run** to execute (or toggle Dry Run OFF first to allow writes)

---

## Configuration (VS Code Settings)

Open **Settings → Extensions → My Cursor** (or edit your `settings.json`).

| Setting | Type | Default | What it does |
| --- | --- | --- | --- |
| `myCursor.provider` | string enum | `"gemini"` | Provider routed via the proxy: `"gemini"`, `"openai"`, `"anthropic"` |
| `myCursor.model` | string | `"gemini-2.0-flash"` | Model id for the selected provider |
| `myCursor.temperature` | number | `0.2` | Generation temperature |
| `myCursor.dryRun` | boolean | `true` | If `true`, **no file/shell changes** are written |
| `myCursor.allowShell` | boolean | `false` | Allow `shell` steps (guarded by Workspace Trust) |
| `myCursor.allowInstall` | boolean | `false` | Allow `install` steps (requires `allowShell=true`) |
| `myCursor.autoRun` | boolean | `false` | Skip Run confirmation and execute immediately |
| `myCursor.persistHistory` | boolean | `true` | Persist conversation history between sessions |
| `myCursor.openFilesAfterWrite` | boolean | `true` | Auto‑open files that were created/edited |
| `myCursor.maxFilesToOpen` | number | `5` | Limit how many files auto‑open after execution |
| `myCursor.embeddedApiKey` | string | `""` | **DEV ONLY** Gemini key for direct calls if no proxy set |

> **Commands** (Command Palette):
> - **My Cursor: Plan & Run** — main entry
> - **My Cursor: Set Gemini API Key** — stores key in VS Code SecretStorage (for direct Gemini fallback only)
> - **My Cursor: Clear API Key**
> - **My Cursor: Toggle Dry Run**
> - **My Cursor: Clear Conversation History**

---

## Provider & Security Notes

- **Proxy‑first**: The extension prefers the **proxy** (`myCursor.apiProxyUrl`) for all providers. If the proxy call fails and the selected provider isn’t Gemini, it **auto‑falls back to Gemini** through the same proxy once.
- **Direct‑to‑Gemini fallback**: If no proxy is configured, the extension will prompt for a **Gemini** API key and store it safely in **VS Code SecretStorage**. This is intended for local/dev only.
- **Never publish real keys** inside the extension. `embeddedApiKey` is a development fallback for local testing only.
- **Workspace Trust & Path Safety**: All filesystem operations are sanitized to remain **within the current workspace**. Shell/install are disabled by default and require a **trusted** workspace.

---

## How Plans Work

The system prompt instructs the model to produce **only JSON** of this shape:

```json
{
  "goal": "one-line summary",
  "root": ".",
  "steps": [
    {"action":"mkdir","path":"relative/dir"},
    {"action":"write","path":"relative/file","content":"..."},
    {"action":"append","path":"relative/file","content":"..."},
    {"action":"edit","path":"relative/file","find":"text or /regex/gi","replace":"..."},
    {"action":"shell","cmd":"echo hi","cwd":"."},
    {"action":"install","packages":["vite","react"],"dev":false,"cwd":"."}
  ]
}
```

- **Paths are relative** to `root`.
- **Minimal steps**: Avoid redundant `mkdir` if `write` already creates dirs.
- **JS/TS project hints**: When scaffolding, include a working `package.json` if not running a framework CLI.
- **No markdown/explanations** — plain JSON only.

---

## Deploy the Proxy to Vercel

1. Create a new Vercel project from the `server/` directory.
2. Add environment variables (at least one of): `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
3. Deploy. Your endpoint will be something like:

```
https://<your-project>.vercel.app/api/generate
```

4. In VS Code settings, set:

```
"myCursor.apiProxyUrl": "https://<your-project>.vercel.app/api/generate"
```

---

## Local Debug Tips

- Use the **“My Cursor” Output** panel to see execution logs and step outcomes.
- Keep **Dry Run ON** while iterating on plan quality.
- If your plan includes `shell` or `install`, enable the matching settings and ensure **Workspace Trust** is enabled.
- The plan preview webview is **read‑only** by design; re‑run the command to generate new plans.

---

## Troubleshooting

**It keeps asking for an API key.**
- You likely don’t have a proxy URL configured and the extension is in **direct‑Gemini** fallback. Either:
  - Set `myCursor.apiProxyUrl` to your **proxy**; or
  - Use **My Cursor: Set Gemini API Key** to store a Gemini key; or
  - For dev only, set `myCursor.embeddedApiKey`.

**Proxy returns an error.**
- Check provider env vars on the proxy.
- Inspect the proxy logs / function logs on Vercel.
- Ensure you POST the expected body shape (the extension already does this).

**No file changes happen.**
- **Dry Run** may be ON. Toggle it from the command palette.
- Workspace may not be **trusted** (see VS Code status bar).

**“Blocked path outside workspace” error.**
- Your plan referenced a path that resolves **outside** the workspace root. All actions must remain inside the opened folder.

---

## Scripts

### Extension (`client/`)

```bash
# build once
npm run build
# watch
npm run compile
# package VSIX (requires vsce)
npm run package
# publish to marketplace (configure publisher & PAT)
npm run publish
```

### Proxy (`server/`)

```bash
npm run dev       # vercel dev
npm run start     # alias to dev
npm run deploy    # vercel --prod
```

---

## Contributing

PRs welcome! Ideas:
- Additional providers or response adapters
- Richer plan preview (diffs, per-step toggles)
- Sandboxed execution modes (e.g., git-backed “apply/revert” helpers)
- Test suite for plan parsing & execution

