import path from "node:path";

export const PATCH_ROOT = path.resolve("data/patches");
export const STAGED_ROOT = path.join(PATCH_ROOT, "staged");
export const APPLIED_ROOT = path.join(PATCH_ROOT, "applied");
export const BACKUPS_ROOT = path.join(PATCH_ROOT, "backups");
export const LOG_PATH = path.join(PATCH_ROOT, "log.jsonl");

export function opDir(root: string, opId: string) {
  return path.join(root, opId);
}

export function opMetaPath(opId: string) {
  return path.join(opDir(STAGED_ROOT, opId), "op.json");
}
