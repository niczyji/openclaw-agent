import { promises as fs } from "node:fs";
import path from "node:path";
import type { Session } from "./store.js";

const SESS_DIR = path.resolve("data/sessions");

export type SessionInfo = {
  id: string;
  path: string;
  size: number;
  updatedAt?: string;
  createdAt?: string;
  messageCount?: number;
};

function sessionPath(id: string) {
  return path.join(SESS_DIR, `${id}.json`);
}

export async function listSessions(): Promise<SessionInfo[]> {
  await fs.mkdir(SESS_DIR, { recursive: true });
  const files = await fs.readdir(SESS_DIR);

  const infos: SessionInfo[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(SESS_DIR, f);
    const st = await fs.stat(p);

    const id = f.replace(/\.json$/, "");
    // best effort parse
    try {
      const raw = await fs.readFile(p, "utf8");
      const s = JSON.parse(raw) as Session;
      infos.push({
        id,
        path: p,
        size: st.size,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        messageCount: s.messages?.length ?? 0,
      });
    } catch {
      infos.push({ id, path: p, size: st.size });
    }
  }

  infos.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return infos;
}

export async function readSessionFile(id: string): Promise<Session> {
  const raw = await fs.readFile(sessionPath(id), "utf8");
  return JSON.parse(raw) as Session;
}

export async function deleteSession(id: string): Promise<void> {
  await fs.unlink(sessionPath(id));
}

export async function exportSessionMarkdown(id: string): Promise<string> {
  const s = await readSessionFile(id);
  const lines: string[] = [];
  lines.push(`# Session ${s.id}`);
  lines.push(`- Created: ${s.createdAt}`);
  lines.push(`- Updated: ${s.updatedAt}`);
  lines.push(`- Messages: ${s.messages.length}`);
  lines.push("");

  for (const m of s.messages) {
    const who = m.role.toUpperCase();
    lines.push(`## ${who}`);
    lines.push(m.content.trim());
    lines.push("");
  }

  return lines.join("\n");
}

export async function pruneSessionsOlderThan(days: number): Promise<string[]> {
  const infos = await listSessions();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const removed: string[] = [];
  for (const i of infos) {
    const ts = i.updatedAt ? Date.parse(i.updatedAt) : NaN;
    if (!Number.isNaN(ts) && ts < cutoff) {
      await deleteSession(i.id);
      removed.push(i.id);
    }
  }
  return removed;
}
