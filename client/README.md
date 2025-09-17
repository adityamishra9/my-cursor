# My Cursor

Turn natural language into safe, reviewable workspace changes:
1. **Plan** with Gemini (strict JSON schema),
2. **Preview** steps,
3. **Execute** safely (dry-run by default).

## Features
- Write/append/edit files, mkdir, run shell commands, `npm i` (opt-in)
- Workspace Trust aware
- Secrets stored via VS Code SecretStorage
- Post-run file tree + result summary

## Commands
- `My Cursor: Plan & Run`
- `My Cursor: Set Gemini API Key`
- `My Cursor: Clear API Key`
- `My Cursor: Toggle Dry Run`

## Settings
- `myCursor.model` (default: `gemini-2.0-flash`)
- `myCursor.temperature` (default: `0.2`)
- `myCursor.dryRun` (default: `true`)
- `myCursor.allowShell` (default: `false`)
- `myCursor.allowInstall` (default: `false`)

## Privacy & Security
- No keys are hard-coded. Your API key is stored in SecretStorage.
- Shell and installation are disabled by default and require Workspace Trust.

## License
MIT
