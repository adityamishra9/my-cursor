import * as vscode from "vscode";
import * as path from "path";
import { Plan } from "./plan";
import { withinWorkspace, requireTrustedWorkspace } from "./sanitize";
import { fileTree } from "./fileTree";
import { promisify } from "util";
import { exec as execCb } from "node:child_process";
const exec = promisify(execCb);

type Result =
  | { step: string; ok: true; stdout?: string; stderr?: string }
  | { step: string; ok: false; error: string };

function getCfg() {
  const cfg = vscode.workspace.getConfiguration("myCursor");
  return {
    dryRun: cfg.get<boolean>("dryRun", true),
    allowShell: cfg.get<boolean>("allowShell", false),
    allowInstall: cfg.get<boolean>("allowInstall", false),
    openFilesAfterWrite: cfg.get<boolean>("openFilesAfterWrite", true),
    maxFilesToOpen: cfg.get<number>("maxFilesToOpen", 5),
  };
}

async function readFile(uri: vscode.Uri): Promise<string> {
  const buf = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(buf).toString("utf8");
}

export async function executePlan(
  plan: Plan,
  workspaceFolder: vscode.WorkspaceFolder,
  output: vscode.OutputChannel
): Promise<{ results: Result[]; tree: string[] }> {
  const cfg = getCfg();
  const root = withinWorkspace(workspaceFolder.uri, plan.root || ".");
  const results: Result[] = [];
  const toOpen: vscode.Uri[] = [];

  if (cfg.dryRun) {
    output.appendLine(
      "DRY RUN: No changes will be written. Use “My Cursor: Toggle Dry Run” to allow execution."
    );
  }

  // trust gate
  if (!cfg.dryRun) {
    requireTrustedWorkspace();
  }

  const ensureDir = async (dirUri: vscode.Uri) => {
    try {
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {}
  };

  const safeWrite = async (relPath: string, content: string) => {
    const uri = withinWorkspace(root, relPath);
    if (!cfg.dryRun) {
      await ensureDir(vscode.Uri.file(path.dirname(uri.fsPath)));
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(content ?? "", "utf8")
      );
      if (cfg.openFilesAfterWrite && toOpen.length < cfg.maxFilesToOpen) {
        toOpen.push(uri);
      }
    }
  };

  const safeAppend = async (relPath: string, content: string) => {
    const uri = withinWorkspace(root, relPath);
    if (!cfg.dryRun) {
      await ensureDir(vscode.Uri.file(path.dirname(uri.fsPath)));
      let old = "";
      try {
        old = await readFile(uri);
      } catch {}
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(old + (content ?? ""), "utf8")
      );
      if (cfg.openFilesAfterWrite && toOpen.length < cfg.maxFilesToOpen) {
        toOpen.push(uri);
      }
    }
  };

  const safeEdit = async (relPath: string, find: string, replace: string) => {
    const uri = withinWorkspace(root, relPath);
    const data = await (async () => {
      try {
        return await readFile(uri);
      } catch {
        throw new Error(`Cannot edit missing file: ${relPath}`);
      }
    })();
    let out = data;
    if (find && find.startsWith("/") && find.endsWith("/")) {
      const last = find.lastIndexOf("/");
      const body = find.slice(1, last);
      const flags = find.slice(last + 1);
      const re = new RegExp(body, flags);
      out = data.replace(re, replace ?? "");
    } else {
      out = data.split(find).join(replace ?? "");
    }
    if (!cfg.dryRun) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(out, "utf8"));
      if (cfg.openFilesAfterWrite && toOpen.length < cfg.maxFilesToOpen) {
        toOpen.push(uri);
      }
    }
  };

  const runShell = async (cmd: string, cwdRel = ".") => {
    if (!cfg.allowShell)
      throw new Error(
        "Shell execution is disabled in settings (myCursor.allowShell=false)."
      );
    const cwdUri = withinWorkspace(root, cwdRel);
    const { stdout, stderr } = cfg.dryRun
      ? { stdout: "", stderr: "" }
      : await exec(cmd, {
          cwd: cwdUri.fsPath,
          env: process.env,
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        });
    return { stdout, stderr };
  };

  const installPkgs = async (pkgs: string[], dev = false, cwdRel = ".") => {
    if (!cfg.allowInstall)
      throw new Error(
        "Package installation is disabled (myCursor.allowInstall=false)."
      );
    if (!Array.isArray(pkgs) || pkgs.length === 0)
      return { stdout: "", stderr: "" };
    const flag = dev ? "-D" : "";
    return runShell(
      `npm i ${flag} ${pkgs.map((p) => JSON.stringify(p)).join(" ")}`,
      cwdRel
    );
  };

  // Execute steps
  for (const [i, step] of (plan.steps || []).entries()) {
    const tag = `#${i + 1} ${step.action}`;
    try {
      switch (step.action) {
        case "mkdir":
          if (!cfg.dryRun)
            await ensureDir(withinWorkspace(root, step.path || "."));
          results.push({ step: tag, ok: true });
          break;
        case "write":
          if (!step.path) throw new Error("write: missing path");
          await safeWrite(step.path, step.content ?? "");
          results.push({ step: tag, ok: true });
          break;
        case "append":
          if (!step.path) throw new Error("append: missing path");
          await safeAppend(step.path, step.content ?? "");
          results.push({ step: tag, ok: true });
          break;
        case "edit":
          if (!step.path) throw new Error("edit: missing path");
          if (typeof step.find !== "string")
            throw new Error("edit: find must be string (text or /regex/flags)");
          await safeEdit(step.path, step.find, step.replace ?? "");
          results.push({ step: tag, ok: true });
          break;
        case "shell": {
          if (!step.cmd) throw new Error("shell: missing cmd");
          const { stdout, stderr } = await runShell(step.cmd, step.cwd || ".");
          results.push({ step: tag, ok: true, stdout, stderr });
          break;
        }
        case "install": {
          const { stdout, stderr } = await installPkgs(
            step.packages || [],
            !!step.dev,
            step.cwd || "."
          );
          results.push({ step: tag, ok: true, stdout, stderr });
          break;
        }
        default:
          throw new Error(`Unknown action: ${(step as any).action}`);
      }
    } catch (err: any) {
      results.push({
        step: tag,
        ok: false,
        error: String(err?.message || err),
      });
    }
  }

  // open new/edited files
  for (const uri of toOpen) {
    try {
      await vscode.window.showTextDocument(uri, { preview: false });
    } catch {}
  }

  const tree = await fileTree(root);
  return { results, tree };
}
