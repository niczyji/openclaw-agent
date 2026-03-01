import fs from "node:fs/promises";
import path from "node:path";
import { loadOp, saveOp, appendLog } from "./store";
import { BACKUPS_ROOT, opDir } from "./paths";

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function rollbackOperation(opId: string) {
  const op = await loadOp(opId);
  if (op.status !== "applied")
    throw new Error(`Operation not applied: ${op.status}`);

  const backupBase = opDir(BACKUPS_ROOT, opId);

  for (const f of op.files) {
    const repoPath = path.resolve(f.targetPath);
    const backupPath = path.join(backupBase, f.targetPath);

    // If file was missing originally
    if (await exists(backupPath + ".missing")) {
      try {
        await fs.unlink(repoPath);
      } catch {}
      continue;
    }

    const backup = await fs.readFile(backupPath);
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    await fs.writeFile(repoPath, backup);
  }

  op.status = "rolled_back";
  op.rolledBackAt = new Date().toISOString();
  await saveOp(op);
  await appendLog({ t: new Date().toISOString(), type: "rollback", opId });

  return { ok: true, opId, status: op.status };
}
