// src/features/verkaufpilot/db/messageRepo.ts

/**
 * Repository for VerkaufPilot messages and items.
 *
 * All functions are synchronous (node:sqlite uses the synchronous API).
 * Items are created on-demand when a message with a known kleinanzeigen_id
 * is upserted for the first time.
 */

import { getDb } from "./db.js";
import type { KleinanzeigenMessage } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageStatus = "new" | "suggested" | "replied" | "closed" | "paid" | "shipped";

export type MessageRecord = {
  id: number;
  gmail_message_id: string;
  item_id: number | null;
  sender_name: string | null;
  message_text: string;
  intent: string;
  subject: string | null;
  received_at: string | null;
  imported_at: string;
  raw_json: string | null;
  status: MessageStatus;
  payment_reference: string | null;
};

export type ItemRecord = {
  id: number;
  kleinanzeigen_id: string | null;
  title: string;
  created_at: string;
};

export type UpsertMessageInput = {
  gmailMessageId: string;
  parsed: KleinanzeigenMessage;
  importedAt: string;
  /** Optional: pass the full JSON string of the import record for auditing. */
  rawJson?: string;
};

export type UpsertResult = {
  inserted: boolean;
  messageId: number | null;
  itemId: number | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find or create an item row for the given listing.
 * Returns null if no kleinanzeigen_id is available (we don't create
 * item rows for unknown listings to avoid orphaned duplicates).
 */
function getOrCreateItemId(parsed: KleinanzeigenMessage): number | null {
  if (!parsed.itemId) return null;

  const db = getDb();

  const existing = db
    .prepare("SELECT id FROM items WHERE kleinanzeigen_id = ?")
    .get(parsed.itemId) as { id: number } | undefined;

  if (existing) return existing.id;

  const result = db
    .prepare("INSERT INTO items (kleinanzeigen_id, title) VALUES (?, ?)")
    .run(parsed.itemId, parsed.itemTitle);

  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a message record.
 * Silently skips if gmail_message_id already exists (INSERT OR IGNORE).
 * Also upserts the parent item if the listing ID is known.
 */
export function upsertMessage(input: UpsertMessageInput): UpsertResult {
  const itemId = getOrCreateItemId(input.parsed);

  const db = getDb();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO messages
         (gmail_message_id, item_id, sender_name, message_text,
          intent, subject, received_at, imported_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.gmailMessageId,
      itemId,
      input.parsed.senderName ?? null,
      input.parsed.messageText,
      input.parsed.intent,
      input.parsed.subject ?? null,
      input.parsed.receivedAt ?? null,
      input.importedAt,
      input.rawJson ?? null,
    );

  const inserted = result.changes > 0;
  const messageId = inserted ? Number(result.lastInsertRowid) : null;

  return { inserted, messageId, itemId };
}

/** Return all messages ordered by received_at descending. */
export function getAllMessages(): MessageRecord[] {
  return getDb()
    .prepare("SELECT * FROM messages ORDER BY received_at DESC")
    .all() as MessageRecord[];
}

/** Return all messages for a specific intent. */
export function getMessagesByIntent(intent: string): MessageRecord[] {
  return getDb()
    .prepare(
      "SELECT * FROM messages WHERE intent = ? ORDER BY received_at DESC",
    )
    .all(intent) as MessageRecord[];
}

/** Return all messages for a specific item (by DB item id). */
export function getMessagesByItemId(itemId: number): MessageRecord[] {
  return getDb()
    .prepare(
      "SELECT * FROM messages WHERE item_id = ? ORDER BY received_at ASC",
    )
    .all(itemId) as MessageRecord[];
}

/** Return all items. */
export function getAllItems(): ItemRecord[] {
  return getDb()
    .prepare("SELECT * FROM items ORDER BY created_at DESC")
    .all() as ItemRecord[];
}

/** Return an item by its DB id. */
export function getItemById(id: number): ItemRecord | null {
  return (
    (getDb()
      .prepare("SELECT * FROM items WHERE id = ?")
      .get(id) as ItemRecord | undefined) ?? null
  );
}

/** Return an item by its Kleinanzeigen listing ID. */
export function getItemByKleinanzeigenId(
  kleinanzeigenId: string,
): ItemRecord | null {
  return (
    (getDb()
      .prepare("SELECT * FROM items WHERE kleinanzeigen_id = ?")
      .get(kleinanzeigenId) as ItemRecord | undefined) ?? null
  );
}

/** Update the lifecycle status of a message. */
export function updateMessageStatus(id: number, status: MessageStatus): void {
  getDb()
    .prepare("UPDATE messages SET status = ? WHERE id = ?")
    .run(status, id);
}

/** Store a human-friendly payment reference for a message. */
export function setPaymentReference(id: number, ref: string): void {
  getDb()
    .prepare("UPDATE messages SET payment_reference = ? WHERE id = ?")
    .run(ref, id);
}

/**
 * Find a message by its exact payment_reference (case-insensitive).
 * Returns null if not found.
 */
export function getMessageByPaymentReference(
  ref: string,
): MessageRecord | null {
  return (
    (getDb()
      .prepare(
        "SELECT * FROM messages WHERE LOWER(payment_reference) = LOWER(?)",
      )
      .get(ref) as MessageRecord | undefined) ?? null
  );
}

/**
 * Return all messages that have a non-null payment_reference,
 * ordered newest first. Used for fuzzy fallback matching.
 */
export function getMessagesWithPaymentReference(): MessageRecord[] {
  return getDb()
    .prepare(
      "SELECT * FROM messages WHERE payment_reference IS NOT NULL ORDER BY received_at DESC",
    )
    .all() as MessageRecord[];
}

/** Return all messages for a specific status. */
export function getMessagesByStatus(status: MessageStatus): MessageRecord[] {
  return getDb()
    .prepare(
      "SELECT * FROM messages WHERE status = ? ORDER BY received_at DESC",
    )
    .all(status) as MessageRecord[];
}

/** Look up a single message by its numeric DB id. */
export function getMessageById(id: number): MessageRecord | null {
  return (
    (getDb()
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as MessageRecord | undefined) ?? null
  );
}

/** Return a quick summary: total messages and a count per intent. */
export function getSummary(): {
  totalMessages: number;
  byIntent: Record<string, number>;
} {
  const db = getDb();

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
  ).n;

  const rows = db
    .prepare("SELECT intent, COUNT(*) AS n FROM messages GROUP BY intent")
    .all() as { intent: string; n: number }[];

  const byIntent: Record<string, number> = {};
  for (const row of rows) byIntent[row.intent] = row.n;

  return { totalMessages: total, byIntent };
}
