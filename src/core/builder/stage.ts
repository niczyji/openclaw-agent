import fs from "node:fs/promises";
import path from "node:path";
import type { BuilderOperation } from "../types";
import { STAGED_ROOT, opDir } from "./paths";
import { assertSafeRepoRelativePath } from "./validate";
import { loadOp, newOperationId, saveOp, appendLog } from "./store";

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function stageFile(args: {
  opId?: string;
  targetPath: string;
  content: string;
  note?: string;
}) {
  const targetPath = assertSafeRepoRelativePath(args.targetPath);
  const opId = args.opId ?? newOperationId();

  // Extra hard guardrail (defense in depth)
  const blockedPrefixes = [
    "src/tools/policy",
    "src/core/builder",
    ".git",
    ".env",
    "node_modules",
  ];
  if (blockedPrefixes.some((p) => targetPath.startsWith(p))) {
    throw new Error(`Blocked targetPath for staging: ${targetPath}`);
  }

  let op: BuilderOperation;
  try {
    op = await loadOp(opId);
    if (op.status !== "staged")
      throw new Error(`Operation not staged: ${op.status}`);
  } catch {
    op = {
      id: opId,
      createdAt: new Date().toISOString(),
      status: "staged",
      files: [],
      note: args.note,
    };
  }

  const stageBase = opDir(STAGED_ROOT, opId);
  const stagedPath = path.join(stageBase, targetPath);

  await ensureDir(path.dirname(stagedPath));
  await fs.writeFile(stagedPath, args.content, "utf8");

  // Upsert file entry
  const existing = op.files.find((f) => f.targetPath === targetPath);
  if (existing) existing.stagedPath = stagedPath;
  else op.files.push({ targetPath, stagedPath });

  await saveOp(op);
  await appendLog({
    t: new Date().toISOString(),
    type: "stage_file",
    opId,
    targetPath,
  });

  return {
    opId: op.id,
    files: op.files.map((f) => f.targetPath),
  };
}
