import type { KleinanzeigenMessage } from "./types.js";
import { classifyKleinanzeigenIntent } from "./classifyKleinanzeigenIntent.js";

type ParseKleinanzeigenMailMeta = {
  subject?: string | null;
  receivedAt?: string | null;
};

function extractMatch(input: string, regex: RegExp): string | null {
  const match = input.match(regex);
  return match?.[1]?.trim() ?? null;
}

export function parseKleinanzeigenMail(
  raw: string,
  meta?: ParseKleinanzeigenMailMeta,
): KleinanzeigenMessage {
  const normalized = raw.replace(/\r\n/g, "\n");

  const subjectFromHeader = meta?.subject ?? null;

  const subject =
    subjectFromHeader ??
    extractMatch(normalized, /Antwort zur Anzeige "([^"]+)"/i) ??
    extractMatch(normalized, /Anzeige "([^"]+)"/i) ??
    null;

  const itemTitle =
    extractMatch(
      subjectFromHeader ?? "",
      /Nutzer-Anfrage zu deiner Anzeige "([^"]+)"/i,
    ) ??
    extractMatch(subjectFromHeader ?? "", /Anzeige "([^"]+)"/i) ??
    extractMatch(normalized, /Antwort zur Anzeige "([^"]+)"/i) ??
    extractMatch(normalized, /Anzeige "([^"]+)"/i) ??
    "Unknown item";

  const itemId =
    extractMatch(normalized, /ad\s+(\d+)/i) ??
    extractMatch(normalized, /Anzeigennummer:\s*(\d+)/i) ??
    null;

  const senderName =
    extractMatch(normalized, /^(.+?) über Kleinanzeigen/i) ??
    extractMatch(normalized, /Antwort von\s+([^\n]+)/i) ??
    null;

  const parts = normalized.split(/\n\s*\n/);

  let messageText = parts[1]?.trim() ?? "";

  if (!messageText) {
    messageText = normalized.trim();
  }

  return {
    source: "kleinanzeigen",
    type: "buyer_message",
    itemTitle,
    itemId,
    senderName,
    messageText,
    receivedAt: meta?.receivedAt ?? null,
    subject,
    intent: classifyKleinanzeigenIntent(messageText),
  };
}
