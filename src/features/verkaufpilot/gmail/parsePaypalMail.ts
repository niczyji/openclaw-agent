// src/features/verkaufpilot/gmail/parsePaypalMail.ts
//
// Parses a PayPal "Zahlung erhalten" (payment received) notification email.
// Extracts sender name, amount, currency, and the payment note/Verwendungszweck.
// Also extracts the structured VerkaufPilot reference if present:
//   VP|MSG:<messageId>|ITEMID:<itemId>

export type PaypalPayment = {
  senderName: string | null;
  amount: string | null;
  currency: string | null;
  /** Raw payment note as written by the buyer. */
  note: string | null;
  /** Parsed VP reference, if the buyer included it in the note. */
  vpRef: VpReference | null;
};

export type VpReference = {
  messageId: number;
  itemId: number;
};

/**
 * Parse a VP|MSG:<id>|ITEMID:<id> reference from any string.
 * Returns null if the reference is absent or malformed.
 */
export function parseVpReference(text: string): VpReference | null {
  const match = text.match(/VP\|MSG:(\d+)\|ITEMID:(\d+)/i);
  if (!match) return null;
  const messageId = parseInt(match[1]!, 10);
  const itemId = parseInt(match[2]!, 10);
  if (isNaN(messageId) || isNaN(itemId)) return null;
  return { messageId, itemId };
}

/**
 * Extract a header value from a Gmail payload headers array.
 */
function header(headers: { name: string; value: string }[], name: string): string | null {
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

/**
 * Parse a PayPal notification email body (plain text).
 *
 * PayPal DE plain-text emails vary by version, so we use multiple
 * fallback patterns for each field.
 */
export function parsePaypalMailBody(body: string): Pick<PaypalPayment, "senderName" | "amount" | "currency" | "note"> {
  // --- Sender name ---
  // "Sie haben eine Zahlung von Vorname Nachname erhalten."
  // "Max Mustermann hat Ihnen [amount] gesendet"
  let senderName: string | null = null;
  const senderPatterns = [
    /Sie haben eine Zahlung von (.+?) erhalten/i,
    /^(.+?) hat Ihnen .+ gesendet/im,
    /Zahlung von (.+?) \(/i,
  ];
  for (const p of senderPatterns) {
    const m = body.match(p);
    if (m?.[1]) { senderName = m[1].trim(); break; }
  }

  // --- Amount + currency ---
  // "19,99 EUR" / "EUR 19.99" / "+19,99 EUR"
  let amount: string | null = null;
  let currency: string | null = null;
  const amountPatterns = [
    /([+-]?\s*[\d.,]+)\s*(EUR|USD|GBP|CHF|PLN)/i,
    /(EUR|USD|GBP|CHF|PLN)\s*([\d.,]+)/i,
  ];
  for (const p of amountPatterns) {
    const m = body.match(p);
    if (m) {
      // Determine which group is amount vs currency
      if (/EUR|USD|GBP|CHF|PLN/i.test(m[1]!)) {
        currency = m[1]!.trim().toUpperCase();
        amount = m[2]!.trim();
      } else {
        amount = m[1]!.trim().replace(/\s/g, "");
        currency = m[2]!.trim().toUpperCase();
      }
      break;
    }
  }

  // --- Payment note / Verwendungszweck ---
  // "Verwendungszweck: ..."
  // "Nachricht: ..."
  // "Betreff: ..." (older templates)
  let note: string | null = null;
  const notePatterns = [
    /Verwendungszweck:\s*(.+?)(?:\n|$)/i,
    /Nachricht(?:\s+des\s+Absenders)?:\s*(.+?)(?:\n|$)/i,
    /Betreff:\s*(.+?)(?:\n|$)/i,
    /Note:\s*(.+?)(?:\n|$)/i,
  ];
  for (const p of notePatterns) {
    const m = body.match(p);
    if (m?.[1]?.trim()) { note = m[1].trim(); break; }
  }

  return { senderName, amount, currency, note };
}

/**
 * Full parse of a PayPal email: body + optional subject fallback.
 */
export function parsePaypalMail(
  body: string,
  opts: { subject?: string | null } = {},
): PaypalPayment {
  const parsed = parsePaypalMailBody(body);

  // Also scan the subject for a VP reference (buyers sometimes put it in subject)
  const searchText = [body, opts.subject ?? ""].join(" ");
  const vpRef = parseVpReference(searchText);

  return { ...parsed, vpRef };
}
