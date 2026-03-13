// src/features/verkaufpilot/db/db.ts

/**
 * SQLite singleton for VerkaufPilot.
 *
 * Uses the built-in node:sqlite module (available since Node.js 22.5).
 * The database file is created at data/verkaufpilot.db relative to the
 * project root (process.cwd()).
 *
 * Call getDb() wherever you need a database handle. The schema migration
 * runs automatically on first open.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema.js";

const DB_PATH = path.resolve(process.cwd(), "data/verkaufpilot.db");

let _instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_instance) return _instance;

  // Ensure the data directory exists before opening the file.
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _instance = new DatabaseSync(DB_PATH);

  // WAL mode: better concurrent read performance.
  _instance.exec("PRAGMA journal_mode = WAL;");

  // Run schema migrations (all CREATE ... IF NOT EXISTS — safe to re-run).
  _instance.exec(SCHEMA_SQL);

  // Column migrations (ALTER TABLE — conditional, since SQLite has no IF NOT EXISTS for columns).
  runColumnMigrations(_instance);

  return _instance;
}

/**
 * Run any ALTER TABLE migrations that can't use IF NOT EXISTS.
 * Each migration checks PRAGMA table_info before running.
 */
function runColumnMigrations(db: DatabaseSync): void {
  const messageColumns = (
    db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
  ).map((c) => c.name);

  if (!messageColumns.includes("status")) {
    db.exec(
      `ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`,
    );
  }

  if (!messageColumns.includes("payment_reference")) {
    db.exec(`ALTER TABLE messages ADD COLUMN payment_reference TEXT`);
  }
}

/** Close the database. Useful in tests or clean-shutdown scenarios. */
export function closeDb(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
