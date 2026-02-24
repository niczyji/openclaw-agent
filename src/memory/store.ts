import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LlmMessage } from "../core/types";

const SESS_DIR = path.resolve("data/sessions");

export type Session = {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: LlmMessage[];
};

function nowISO() {
  return new Date().toISOString();
}

export function newSessionId() {
  return crypto.randomUUID();
}

function sessionPath(id: string) {
  return path.join(SESS_DIR, `${id}.json`);
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    const raw = await fs.readFile(sessionPath(id), "utf8");
    return JSON.parse(raw) as Session;
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

export async function saveSession(s: Session): Promise<void> {
  await fs.mkdir(SESS_DIR, { recursive: true });
  s.updatedAt = nowISO();
  await fs.writeFile(sessionPath(s.id), JSON.stringify(s, null, 2), "utf8");
}

export async function getOrCreateSession(id?: string): Promise<Session> {
  if (id) {
    const existing = await loadSession(id);
    if (existing) return existing;
    return {
      id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      messages: [],
    };
  }

  const newId = newSessionId();
  return {
    id: newId,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    messages: [],
  };
}
