// src/features/verkaufpilot/gmail/importPaypalFromGmail.ts
//
// Fetches PayPal payment notification emails from Gmail and matches them to
// VerkaufPilot message threads using a three-tier strategy:
//
//   1. Exact match:   payment_reference in DB == PayPal note (case-insensitive)
//   2. Partial match: PayPal note contains payment_reference as substring
//   3. Fuzzy fallback: buyer first name in PayPal sender name matches DB sender_name
//      (only for messages without a prior payment, received in the last 90 days)
//
// On a successful match the message status is updated to "paid".

import { createGmailClient } from "./createGmailClient.js";
import { parsePaypalMail, type PaypalPayment } from "./parsePaypalMail.js";
import {
  getMessageById,
  getMessageByPaymentReference,
  getMessagesWithPaymentReference,
  getAllMessages,
  updateMessageStatus,
  type MessageRecord,
} from "../db/messageRepo.js";

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

/** Normalise a string for comparison: lowercase, trim, collapse whitespace. */
function norm(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Extract first name from a full name string. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * Three-tier match: tries exact → partial → fuzzy.
 * Returns the matched MessageRecord and the tier that matched, or null.
 */
function matchPayment(payment: PaypalPayment): {
  msg: MessageRecord;
  tier: "exact" | "partial" | "fuzzy";
} | null {
  const note = payment.note ?? "";
  const noteNorm = norm(note);

  // --- Tier 1: exact payment_reference match ---
  if (note.trim()) {
    const exactMatch = getMessageByPaymentReference(note.trim());
    if (exactMatch) return { msg: exactMatch, tier: "exact" };
  }

  // --- Tier 2: payment_reference is a substring of the PayPal note ---
  if (noteNorm) {
    const candidates = getMessagesWithPaymentReference();
    for (const candidate of candidates) {
      if (
        candidate.payment_reference &&
        noteNorm.includes(norm(candidate.payment_reference))
      ) {
        return { msg: candidate, tier: "partial" };
      }
    }
  }

  // --- Tier 3: fuzzy — token-based matching on the stored payment_reference ---
  // The reference format is "<ItemTitle> <BuyerFirstName> <ListingId>".
  // We match if the buyer first name AND at least one other token (title or ID)
  // appear in the PayPal note. This avoids false positives from name-only matches.
  if (noteNorm) {
    const candidates = getMessagesWithPaymentReference();
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    for (const candidate of candidates) {
      if (!candidate.payment_reference) continue;
      if (candidate.status === "paid" || candidate.status === "shipped" || candidate.status === "closed") continue;
      if (candidate.received_at != null && candidate.received_at < cutoff) continue;

      // Tokenise the stored reference (space-separated)
      const tokens = candidate.payment_reference
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter((t) => t.length >= 2);

      if (tokens.length < 2) continue;

      // Count how many tokens appear in the PayPal note
      const hits = tokens.filter((t) => noteNorm.includes(t)).length;

      // Require at least 2 tokens to match (reduces false positives)
      if (hits >= 2) {
        return { msg: candidate, tier: "fuzzy" };
      }
    }
  }

  // Last-resort: PayPal sender first name matches DB buyer first name
  // (only when no payment_reference candidates exist)
  const paypalSender = payment.senderName;
  if (paypalSender) {
    const paypalFirst = firstName(paypalSender);
    if (paypalFirst.length >= 3) {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const recentMessages = getAllMessages().filter(
        (m) =>
          m.received_at != null &&
          m.received_at >= cutoff &&
          !m.payment_reference &&
          m.status !== "paid" &&
          m.status !== "shipped" &&
          m.status !== "closed",
      );

      for (const m of recentMessages) {
        if (!m.sender_name) continue;
        const dbFirst = firstName(m.sender_name);
        if (dbFirst.length >= 3 && dbFirst === paypalFirst) {
          return { msg: m, tier: "fuzzy" };
        }
      }
    }
  }

  return null;
}

export type PaypalImportResult = {
  /** Number of PayPal emails inspected. */
  total: number;
  /** Number of emails matched to a DB message. */
  matched: number;
  /** Number that matched via exact payment_reference. */
  matchedExact: number;
  /** Number that matched via partial reference substring. */
  matchedPartial: number;
  /** Number that matched via fuzzy sender name. */
  matchedFuzzy: number;
  /** Number of emails that could not be matched. */
  unmatched: number;
  /** Details for each matched payment. */
  payments: MatchedPayment[];
};

export type MatchedPayment = {
  gmailMessageId: string;
  messageId: number;
  matchTier: "exact" | "partial" | "fuzzy";
  senderName: string | null;
  amount: string | null;
  currency: string | null;
  note: string | null;
};

export async function importPaypalFromGmail(): Promise<PaypalImportResult> {
  const gmail = await createGmailClient();

  // PayPal sends from service@paypal.de (DE) or service@paypal.com (international).
  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: 20,
    q: "from:(service@paypal.de OR service@paypal.com) newer_than:90d",
  });

  const messages = listRes.data.messages ?? [];
  console.log(`PayPal import: found ${messages.length} emails`);

  const result: PaypalImportResult = {
    total: messages.length,
    matched: 0,
    matchedExact: 0,
    matchedPartial: 0,
    matchedFuzzy: 0,
    unmatched: 0,
    payments: [],
  };

  for (const msg of messages) {
    if (!msg.id) continue;

    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full",
    });

    const payload = full.data.payload;
    const bodyText = extractPlainText(payload);
    const subject = getHeader(payload, "Subject");

    if (!bodyText) continue;

    const payment: PaypalPayment = parsePaypalMail(bodyText, { subject });
    const match = matchPayment(payment);

    if (!match) {
      console.log(
        `PayPal: no match for email ${msg.id} ` +
        `(sender: ${payment.senderName ?? "–"}, note: ${payment.note ?? "–"})`,
      );
      result.unmatched += 1;
      continue;
    }

    const { msg: dbMsg, tier } = match;

    updateMessageStatus(dbMsg.id, "paid");

    console.log(
      `PayPal [${tier}]: ${payment.senderName ?? "?"} ` +
      `(${payment.amount} ${payment.currency}) → message #${dbMsg.id} → paid`,
    );

    result.matched += 1;
    if (tier === "exact") result.matchedExact += 1;
    else if (tier === "partial") result.matchedPartial += 1;
    else result.matchedFuzzy += 1;

    result.payments.push({
      gmailMessageId: msg.id,
      messageId: dbMsg.id,
      matchTier: tier,
      senderName: payment.senderName,
      amount: payment.amount,
      currency: payment.currency,
      note: payment.note,
    });
  }

  return result;
}
