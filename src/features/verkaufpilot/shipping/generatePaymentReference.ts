// src/features/verkaufpilot/shipping/generatePaymentReference.ts
//
// Generates a human-friendly payment reference for the PayPal Verwendungszweck.
//
// Format:  <ItemShortTitle> <BuyerFirstName> <ListingId>
// Example: Blackstone Markus 3326098406
//
// Rules:
//   ItemShortTitle — first word of the cleaned item title, max 15 chars
//   BuyerFirstName — first whitespace-delimited token of sender name
//   ListingId      — kleinanzeigen_id from the items table if known,
//                    otherwise "MSG<messageId>" as fallback
//
// Buyers include this verbatim in the PayPal payment note.
// Matching supports exact, substring, and token-based fuzzy.

/** Extract the first meaningful word from an item title (max 15 chars). */
function shortItemTitle(title: string): string {
  // Strip leading quotes, "Re:", common prefixes
  const cleaned = title
    .replace(/^Re:\s*/i, "")
    .replace(/^["'"]/g, "")
    .trim();

  const word = cleaned.split(/\s+/)[0] ?? cleaned;
  return word.slice(0, 15);
}

/** Extract first name (first whitespace token). */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name.trim();
}

export function generatePaymentReference(
  itemTitle: string,
  senderName: string | null,
  messageId: number,
  kleinanzeigenId?: string | null,
): string {
  const titlePart = shortItemTitle(itemTitle) || "Artikel";
  const namePart = senderName ? firstName(senderName) : "Käufer";
  const idPart = kleinanzeigenId ?? `MSG${messageId}`;
  return `${titlePart} ${namePart} ${idPart}`;
}
