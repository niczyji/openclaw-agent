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

/**
 * Remove the standard Kleinanzeigen email footer and any quoted reply
 * headers (e.g. "Am Mo., ... schrieb Kleinanzeigen:").
 */
function stripFooter(text: string): string {
  return text
    .replace(/Um auf diese Nachricht zu antworten[\s\S]*/i, "")
    .replace(/Schütze dich vor Betrug[\s\S]*/i, "")
    .replace(/^Am .+schrieb .+:[\s\S]*/im, "")   // quoted-reply header
    .replace(/^>.*$/gm, "")                        // quoted lines starting with >
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the buyer's message text from the raw email body.
 *
 * Strategy 1: grab everything after the "Antwort von [name]" line —
 *   this is the most reliable marker in Kleinanzeigen notification emails.
 * Strategy 2: paragraph split (original fallback).
 * Strategy 3: full text after footer strip.
 */
function extractMessageText(normalized: string): string {
  // Strategy 1: text starts after the "Antwort von ..." line
  const afterSender = normalized.match(/Antwort von [^\n]+\n([\s\S]+)/i);
  if (afterSender?.[1]) {
    const candidate = stripFooter(afterSender[1]);
    if (candidate) return candidate;
  }

  // Strategy 2: second paragraph (classic split)
  const parts = normalized.split(/\n\s*\n/);
  const secondParagraph = parts[1]?.trim() ?? "";
  if (secondParagraph) return stripFooter(secondParagraph);

  // Strategy 3: full body as last resort
  return stripFooter(normalized) || normalized.trim();
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
    extractMatch(normalized, /Anzeigennummer:\s*(\d+)/i) ??
    extractMatch(normalized, /\bad\s+(\d+)/i) ??
    null;

  // Note: the first pattern (/^(.+?) über Kleinanzeigen/) never matched in
  // practice because ^ without the multiline flag anchors to the string start,
  // not a line start. Kept as dead-code-safe by removing the ^ anchor.
  const senderName =
    extractMatch(normalized, /(.+?) über Kleinanzeigen/i) ??
    extractMatch(normalized, /Antwort von\s+([^\n]+)/i) ??
    null;

  const messageText = extractMessageText(normalized);

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
