// src/features/verkaufpilot/dev/reClassifyAll.ts
//
// Re-runs the intent classifier against all messages stored in the DB.
// Use this after improving the classifier to update existing records.

import { getDb } from "../db/db.js";
import { classifyKleinanzeigenIntent } from "../classifyKleinanzeigenIntent.js";

async function main() {
  const db = getDb();

  const rows = db
    .prepare("SELECT id, message_text, intent FROM messages")
    .all() as { id: number; message_text: string; intent: string }[];

  let updated = 0;
  let unchanged = 0;

  for (const row of rows) {
    const newIntent = classifyKleinanzeigenIntent(row.message_text);
    if (newIntent === row.intent) {
      unchanged++;
      continue;
    }

    db.prepare("UPDATE messages SET intent = ? WHERE id = ?").run(
      newIntent,
      row.id,
    );
    console.log(
      `id=${row.id}: ${row.intent} → ${newIntent} | "${row.message_text.slice(0, 60)}"`,
    );
    updated++;
  }

  console.log(
    `\nDone: ${updated} updated, ${unchanged} unchanged (${rows.length} total)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
