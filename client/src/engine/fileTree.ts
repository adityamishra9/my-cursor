// src/engine/fileTree.ts
import * as vscode from "vscode";

export async function fileTree(root: vscode.Uri): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: vscode.Uri, base = ""): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const rel = base ? `${base}/${name}` : name;
      const child = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        out.push(rel + "/");
        await walk(child, rel);
      } else {
        out.push(rel);
      }
    }
  }
  await walk(root);
  return out.sort();
}
