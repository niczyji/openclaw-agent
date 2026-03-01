import fs from "node:fs/promises";
import path from "node:path";
import { loadOp } from "./store";

function simpleUnifiedDiff(a: string, b: string, file: string) {
  // ultra-prosty line diff: pokaże całość jako “- / +” jeśli różne
  if (a === b) return `--- ${file}\n+++ ${file}\n(no changes)\n`;

  const aLines = a.split("\n");
  const bLines = b.split("\n");

  const out: string[] = [];
  out.push(`--- ${file}`);
  out.push(`+++ ${file}`);
  out.push(`@@ -1,${aLines.length} +1,${bLines.length} @@`);
  for (const line of aLines) out.push(`-${line}`);
  for (const line of bLines) out.push(`+${line}`);
  return out.join("\n") + "\n";
}

export async function diffOperation(opId: string) {
  const op = await loadOp(opId);
  if (op.status !== "staged")
    throw new Error(`Operation not staged: ${op.status}`);
  if (!op.files.length) throw new Error("No staged files");

  const diffs: { file: string; diff: string }[] = [];

  for (const f of op.files) {
    const repoPath = path.resolve(f.targetPath);
    let current = "";
    try {
      current = await fs.readFile(repoPath, "utf8");
    } catch {
      current = "";
    }
    const staged = await fs.readFile(f.stagedPath, "utf8");

    diffs.push({
      file: f.targetPath,
      diff: simpleUnifiedDiff(current, staged, f.targetPath),
    });
  }

  return { ok: true, opId, status: op.status, diffs };
}
