// src/engine/sanitize.ts
import * as path from "path";
import * as vscode from "vscode";

export function withinWorkspace(root: vscode.Uri, rel: string): vscode.Uri {
  const target = vscode.Uri.joinPath(root, rel);
  // Resolve path and ensure it still sits under workspace folder
  const rootFsPath = root.fsPath;
  const targetFsPath = path.resolve(rootFsPath, rel);
  if (!targetFsPath.startsWith(rootFsPath)) {
    throw new Error(`Blocked path outside workspace: ${rel}`);
  }
  return vscode.Uri.file(targetFsPath);
}

export function requireTrustedWorkspace() {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      "This workspace is not trusted. Enable Workspace Trust to allow file modifications or shell execution."
    );
  }
}
