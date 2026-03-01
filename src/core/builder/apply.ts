import fs from "node:fs/promises";
import path from "node:path";
import { loadOp, saveOp, appendLog } from "./store";
import { BACKUPS_ROOT, APPLIED_ROOT, opDir } from "./paths";

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function applyOperation(opId: string) {
  const op = await loadOp(opId);
  if (op.status !== "staged")
    throw new Error(`Operation not staged: ${op.status}`);
  if (!op.files.length) throw new Error("No staged files");

  const backupBase = opDir(BACKUPS_ROOT, opId);
  const appliedBase = opDir(APPLIED_ROOT, opId);

  await ensureDir(backupBase);
  await ensureDir(appliedBase);

  for (const f of op.files) {
    const repoPath = path.resolve(f.targetPath);

    // backup current (if exists)
    const backupPath = path.join(backupBase, f.targetPath);
    await ensureDir(path.dirname(backupPath));
    try {
      const cur = await fs.readFile(repoPath);
      await fs.writeFile(backupPath, cur);
    } catch {
      // if missing file, create empty marker
      await fs.writeFile(backupPath + ".missing", "");
    }

    // apply staged content
    const staged = await fs.readFile(f.stagedPath);
    await ensureDir(path.dirname(repoPath));
    await fs.writeFile(repoPath, staged);

    // keep copy in applied folder for audit
    const appliedCopy = path.join(appliedBase, f.targetPath);
    await ensureDir(path.dirname(appliedCopy));
    await fs.writeFile(appliedCopy, staged);
  }

  op.status = "applied";
  op.appliedAt = new Date().toISOString();
  await saveOp(op);
  await appendLog({
    t: new Date().toISOString(),
    type: "apply",
    opId,
    files: op.files.map((x) => x.targetPath),
  });

  return {
    ok: true,
    opId,
    status: op.status,
    files: op.files.map((x) => x.targetPath),
  };
}
