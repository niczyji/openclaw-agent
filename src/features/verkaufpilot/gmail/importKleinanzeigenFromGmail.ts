// src/features/verkaufpilot/gmail/importKleinanzeigenFromGmail.ts

import fs from "node:fs/promises";
import path from "node:path";
import { createGmailClient } from "./createGmailClient.js";
import { parseKleinanzeigenMail } from "../parseKleinanzeigenMail.js";

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

export async function importKleinanzeigenFromGmail(): Promise<void> {
  const gmail = await createGmailClient();

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: 10,
    q: "from:mail.kleinanzeigen.de newer_than:30d",
  });

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) {
    console.log("No Kleinanzeigen messages found.");
    return;
  }

  const outDir = path.resolve(
    process.cwd(),
    "data/outputs/verkaufpilot/imports",
  );
  await fs.mkdir(outDir, { recursive: true });

  let importedCount = 0;
  let skippedCount = 0;

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

    const output = {
      gmailMessageId: msg.id,
      importedAt: new Date().toISOString(),
      subject,
      from,
      receivedAt: date,
      parsed,
    };

    await fs.writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

    importedCount += 1;
    console.log(`Imported: ${outPath}`);
  }

  console.log(
    `Import summary: imported=${importedCount}, skipped=${skippedCount}, totalSeen=${messages.length}`,
  );
}
