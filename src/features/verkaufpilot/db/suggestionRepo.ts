// src/features/verkaufpilot/db/suggestionRepo.ts

import { getDb } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuggestionRecord = {
  id: number;
  message_id: number;
  model: string;
  provider: string;
  analysis: string | null;
  reply_main: string;
  reply_alt: string | null;
  generated_at: string;
  sent_to_tg: number; // 0 | 1
  sent_at: string | null;
};

export type InsertSuggestionInput = {
  messageId: number;
  model: string;
  provider: string;
  analysis: string | null;
  replyMain: string;
  replyAlt: string | null;
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Insert a new suggestion. Always inserts (multiple suggestions per message are allowed). */
export function insertSuggestion(input: InsertSuggestionInput): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO suggested_replies
         (message_id, model, provider, analysis, reply_main, reply_alt, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      input.model,
      input.provider,
      input.analysis ?? null,
      input.replyMain,
      input.replyAlt ?? null,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

/** Mark a suggestion as sent to Telegram. */
export function markSentToTg(suggestionId: number): void {
  getDb()
    .prepare(
      `UPDATE suggested_replies SET sent_to_tg = 1, sent_at = ? WHERE id = ?`,
    )
    .run(new Date().toISOString(), suggestionId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Get the most recent suggestion for a message, or null if none. */
export function getLatestSuggestionForMessage(
  messageId: number,
): SuggestionRecord | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM suggested_replies
         WHERE message_id = ?
         ORDER BY generated_at DESC
         LIMIT 1`,
      )
      .get(messageId) as SuggestionRecord | undefined) ?? null
  );
}

/** Get all message IDs that have at least one suggestion. */
export function getMessageIdsWithSuggestions(): Set<number> {
  const rows = getDb()
    .prepare(`SELECT DISTINCT message_id FROM suggested_replies`)
    .all() as { message_id: number }[];
  return new Set(rows.map((r) => r.message_id));
}

/** Get all suggestions, newest first. */
export function getAllSuggestions(): SuggestionRecord[] {
  return getDb()
    .prepare(`SELECT * FROM suggested_replies ORDER BY generated_at DESC`)
    .all() as SuggestionRecord[];
}
