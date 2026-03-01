import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { BuilderOperation } from "../types";
import { STAGED_ROOT, opDir, opMetaPath, LOG_PATH } from "./paths";

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export function newOperationId() {
  const t = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const r = crypto.randomBytes(4).toString("hex");
  return `${t}-${r}`;
}

export async function loadOp(opId: string): Promise<BuilderOperation> {
  const meta = await fs.readFile(opMetaPath(opId), "utf8");
  return JSON.parse(meta) as BuilderOperation;
}

export async function saveOp(op: BuilderOperation) {
  const dir = opDir(STAGED_ROOT, op.id);
  await ensureDir(dir);
  await fs.writeFile(opMetaPath(op.id), JSON.stringify(op, null, 2), "utf8");
}

export async function appendLog(entry: unknown) {
  await ensureDir(path.dirname(LOG_PATH));
  await fs.appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export async function ensureOpExists(opId: string) {
  await fs.access(opMetaPath(opId));
}
