// src/features/verkaufpilot/gmail/importKleinanzeigenFromGmail.ts

import fs from "node:fs/promises";
import path from "node:path";
import { createGmailClient } from "./createGmailClient.js";
import { parseKleinanzeigenMail } from "../parseKleinanzeigenMail.js";
import { upsertMessage } from "../db/messageRepo.js";

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function extractPlainText(payload: any): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }

  return "";
}

function getHeader(payload: any, name: string): string | null {
  const headers = payload?.headers ?? [];
  const found = headers.find(
    (h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export type ImportSummary = {
  imported: number;
  skipped: number;
  total: number;
  /** DB IDs of messages that were freshly inserted (not skipped duplicates). */
  newMessageIds: number[];
};

export async function importKleinanzeigenFromGmail(): Promise<ImportSummary> {
  const gmail = await createGmailClient();

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: 10,
    q: "from:mail.kleinanzeigen.de newer_than:30d",
  });

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) {
    console.log("No Kleinanzeigen messages found.");
    return { imported: 0, skipped: 0, total: 0 };
  }

  const outDir = path.resolve(
    process.cwd(),
    "data/outputs/verkaufpilot/imports",
  );
  await fs.mkdir(outDir, { recursive: true });

  let importedCount = 0;
  let skippedCount = 0;
  const newMessageIds: number[] = [];

  for (const msg of messages) {
    if (!msg.id) continue;

    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full",
    });

    const payload = full.data.payload;
    const bodyText = extractPlainText(payload);
    if (!bodyText) continue;

    const subject = getHeader(payload, "Subject");
    const from = getHeader(payload, "From");
    const date = getHeader(payload, "Date");
    const outPath = path.join(outDir, `${msg.id}.json`);

    if (await fileExists(outPath)) {
      skippedCount += 1;
      console.log(`Skipped (already imported): ${outPath}`);
      continue;
    }

    let parsed: any;
    try {
      parsed = parseKleinanzeigenMail(bodyText, {
        subject,
        receivedAt: date,
      });
    } catch (error: any) {
      parsed = {
        source: "kleinanzeigen",
        type: "unparsed",
        error: String(error?.message ?? error),
        subject,
        from,
        receivedAt: date,
        rawPreview: bodyText.slice(0, 1000),
      };
    }

    const importedAt = new Date().toISOString();

    const output = {
      gmailMessageId: msg.id,
      importedAt,
      subject,
      from,
      receivedAt: date,
      parsed,
    };

    const outputJson = JSON.stringify(output, null, 2);
    await fs.writeFile(outPath, outputJson, "utf8");

    // Persist to SQLite (only for successfully parsed messages).
    if (parsed.type === "buyer_message") {
      const { inserted, messageId } = upsertMessage({
        gmailMessageId: msg.id,
        parsed,
        importedAt,
        rawJson: outputJson,
      });
      if (inserted && messageId != null) {
        newMessageIds.push(messageId);
      } else {
        console.log(`DB: already exists, skipped upsert for ${msg.id}`);
      }
    }

    importedCount += 1;
    console.log(`Imported: ${outPath} (intent: ${parsed.intent ?? "n/a"}`);
  }

  console.log(
    `Import summary: imported=${importedCount}, skipped=${skippedCount}, totalSeen=${messages.length}`,
  );

  return { imported: importedCount, skipped: skippedCount, total: messages.length, newMessageIds };
}
