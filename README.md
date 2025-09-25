# My Cursor — VS Code Agent (Plan → Preview → Execute)

Turn natural language into **safe, reviewable workspace changes**.

This repo contains:

- **client/** — a VS Code extension that generates a JSON **plan** with file ops (mkdir/write/append/edit), optional **shell** and **install** steps, lets you **preview**, and (optionally) **execute** it.
- **server/** — a minimal **proxy API** deployed (e.g. to Vercel) that forwards requests to **Gemini / OpenAI / Anthropic** with a common request format.

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
│   ├── .vscodeignore        # Files excluded from packaged .vsix
│   ├── media/
│   │   └── plan.css         # Styling for plan preview webview
│   ├── package.json         # Extension manifest & scripts
│   ├── src/
│   │   ├── engine/
│   │   │   ├── executor.ts  # Executes plan steps (safe file ops, shell/install behind flags)
│   │   │   ├── fileTree.ts  # Utility to compute workspace file tree
│   │   │   ├── gemini.ts    # Provider routing + system prompt
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

```bash
cd server
npm i
npx vercel dev
# This serves POST /api/generate at http://localhost:3000/api/generate
```

Set **env vars** for your chosen provider(s):

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

### 2) Build & debug the VS Code extension

```bash
cd client
npm i
npm run build
# Press F5 in VS Code to "Run Extension"
```

In the **Extension Development Host**:

- Run **command**: **“My Cursor: Plan & Run”**
- Enter your request
- Inspect the **Plan Preview**
- Choose **Run** to execute

---

## Configuration (VS Code Settings)

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `myCursor.provider` | string enum | `"gemini"` | Provider routed via the proxy: `"gemini"`, `"openai"`, `"anthropic"` |
| `myCursor.model` | string | `"gemini-2.0-flash"` | Model id for the selected provider |
| `myCursor.temperature` | number | `0.2` | Generation temperature |
| `myCursor.allowShell` | boolean | `true` | Allow `shell` steps (guarded by Workspace Trust) |
| `myCursor.allowInstall` | boolean | `true` | Allow `install` steps (requires `allowShell=true`) |
| `myCursor.autoRun` | boolean | `false` | Skip Run confirmation and execute immediately |
| `myCursor.persistHistory` | boolean | `true` | Persist conversation history between sessions |
| `myCursor.openFilesAfterWrite` | boolean | `true` | Auto‑open files created/edited |
| `myCursor.maxFilesToOpen` | number | `5` | Limit how many files auto‑open |
| `myCursor.apiProxyUrl` | string | `"https://cursor.adityamishra.tech/api/generate"` | Proxy endpoint to call |

---

## Deploy the Proxy to Vercel

1. Create a new Vercel project from the `server/` directory.
2. Add environment variables (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
3. Deploy. Endpoint will be:

```
https://<your-project>.vercel.app/api/generate
```

4. In VS Code settings:

```
"myCursor.apiProxyUrl": "https://<your-project>.vercel.app/api/generate"
```

---

## Scripts

### Extension (`client/`)

```bash
npm run build      # build once
npm run compile    # watch
npm run package    # package VSIX
npm run publish    # publish to marketplace
```

### Proxy (`server/`)

```bash
npm run dev       # vercel dev
npm run deploy    # vercel --prod
```

---

## Contributing

PRs welcome! Ideas:
- Additional providers or response adapters
- Richer plan preview (diffs, per-step toggles)
- Sandboxed execution modes (git-backed apply/revert)
- Tests for plan parsing & execution
