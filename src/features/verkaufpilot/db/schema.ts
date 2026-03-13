// src/features/verkaufpilot/db/schema.ts

/**
 * SQLite schema for VerkaufPilot.
 *
 * Tables:
 *   items                — one row per Kleinanzeigen listing
 *   messages             — one row per imported Gmail message
 *   suggested_replies    — AI reply suggestions per message
 *   shipping_addresses   — extracted recipient addresses per message
 *   parcel_preparations  — parcel size + tracking per message
 */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    kleinanzeigen_id  TEXT    UNIQUE,
    title             TEXT    NOT NULL,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_message_id  TEXT    UNIQUE NOT NULL,
    item_id           INTEGER REFERENCES items(id),
    sender_name       TEXT,
    message_text      TEXT    NOT NULL,
    intent            TEXT    NOT NULL,
    subject           TEXT,
    received_at       TEXT,
    imported_at       TEXT    NOT NULL,
    raw_json          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_intent   ON messages(intent);
  CREATE INDEX IF NOT EXISTS idx_messages_item_id  ON messages(item_id);
  CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);

  CREATE TABLE IF NOT EXISTS suggested_replies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    INTEGER NOT NULL REFERENCES messages(id),
    model         TEXT    NOT NULL,
    provider      TEXT    NOT NULL,
    analysis      TEXT,
    reply_main    TEXT    NOT NULL,
    reply_alt     TEXT,
    generated_at  TEXT    NOT NULL,
    sent_to_tg    INTEGER NOT NULL DEFAULT 0,
    sent_at       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_suggestions_msg ON suggested_replies(message_id);

  CREATE TABLE IF NOT EXISTS shipping_addresses (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id       INTEGER NOT NULL REFERENCES messages(id),
    recipient_name   TEXT,
    street           TEXT,
    house_number     TEXT,
    postal_code      TEXT,
    city             TEXT,
    country          TEXT NOT NULL DEFAULT 'DE',
    raw_extracted    TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_shipping_addr_msg ON shipping_addresses(message_id);

  CREATE TABLE IF NOT EXISTS parcel_preparations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id          INTEGER NOT NULL REFERENCES messages(id),
    shipping_address_id INTEGER REFERENCES shipping_addresses(id),
    size_category       TEXT NOT NULL,
    item_reference      TEXT,
    tracking_number     TEXT,
    status              TEXT NOT NULL DEFAULT 'prepared',
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    shipped_at          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_parcel_prep_msg ON parcel_preparations(message_id);
`;
