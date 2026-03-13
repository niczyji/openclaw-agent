// src/features/verkaufpilot/shipping/prepareHermesData.ts
//
// Assembles Hermes shipping preparation data for manual entry on myHermes.de.
// Does NOT automate the website — output is for the human to copy-paste.
//
// Sender address is read from environment variables:
//   HERMES_SENDER_NAME
//   HERMES_SENDER_STREET
//   HERMES_SENDER_HOUSE_NUMBER
//   HERMES_SENDER_POSTAL_CODE
//   HERMES_SENDER_CITY
//   HERMES_SENDER_COUNTRY  (defaults to "DE")

import type { ExtractedAddress } from "./extractAddress.js";
import type { ParcelSizeCategory } from "./estimateParcelSize.js";
import { sizeDescription } from "./estimateParcelSize.js";

export type SenderAddress = {
  name: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  country: string;
};

export type HermesShippingData = {
  sender: SenderAddress;
  recipient: ExtractedAddress;
  sizeCategory: ParcelSizeCategory;
  itemReference: string;
  /** Missing recipient fields that the user must fill in before shipping. */
  missingFields: string[];
  /** Human-readable Telegram card. */
  summary: string;
  /** Semicolon-delimited CSV line for record-keeping. */
  csvLine: string;
};

export const CSV_HEADER =
  "message_id;item_reference;size;recipient_name;street;house_number;postal_code;city;country;sender_name;sender_street;sender_house_number;sender_postal_code;sender_city;sender_country";

/** Read sender address from environment. Throws if any required field is missing. */
export function loadSenderAddress(): SenderAddress {
  const get = (key: string): string => {
    const v = (process.env[key] ?? "").trim();
    if (!v) throw new Error(`Missing env var: ${key}. Add it to .env.`);
    return v;
  };

  return {
    name: get("HERMES_SENDER_NAME"),
    street: get("HERMES_SENDER_STREET"),
    houseNumber: get("HERMES_SENDER_HOUSE_NUMBER"),
    postalCode: get("HERMES_SENDER_POSTAL_CODE"),
    city: get("HERMES_SENDER_CITY"),
    country: (process.env.HERMES_SENDER_COUNTRY ?? "DE").trim(),
  };
}

function field(label: string, value: string | null, missing: string[]): string {
  if (!value) { missing.push(label); return `${label}: ❌ fehlt`; }
  return `${label}: ${value}`;
}

export function prepareHermesData(opts: {
  messageId: number;
  recipient: ExtractedAddress;
  sizeCategory: ParcelSizeCategory;
  itemReference: string;
  sender: SenderAddress;
}): HermesShippingData {
  const { messageId, recipient, sizeCategory, itemReference, sender } = opts;
  const missing: string[] = [];

  // Build recipient line for display
  const recipientLines = [
    field("Name",      recipient.recipientName, missing),
    field("Straße",    recipient.street,         missing),
    field("Hausnr.",   recipient.houseNumber,    missing),
    field("PLZ",       recipient.postalCode,     missing),
    field("Stadt",     recipient.city,           missing),
    `Land: ${recipient.country ?? "DE"}`,
  ];

  const senderLines = [
    `${sender.name}`,
    `${sender.street} ${sender.houseNumber}`,
    `${sender.postalCode} ${sender.city}`,
    `${sender.country}`,
  ];

  const warningBlock = missing.length > 0
    ? `\n⚠️ Fehlende Felder — bitte beim Käufer erfragen:\n${missing.map(f => `  • ${f}`).join("\n")}`
    : "\n✅ Adresse vollständig";

  const summary = [
    `📦 Hermes Versandvorbereitung — Nachricht #${messageId}`,
    `──────────────────────────────`,
    ``,
    `📌 Artikel: ${itemReference}`,
    `📏 Paketgröße: ${sizeDescription(sizeCategory)}`,
    ``,
    `👤 Empfänger:`,
    ...recipientLines.map(l => `  ${l}`),
    ``,
    `🏠 Absender:`,
    ...senderLines.map(l => `  ${l}`),
    warningBlock,
    ``,
    `→ Jetzt auf myhermes.de ausfüllen`,
  ].join("\n");

  const csv = [
    messageId,
    itemReference,
    sizeCategory,
    recipient.recipientName ?? "",
    recipient.street ?? "",
    recipient.houseNumber ?? "",
    recipient.postalCode ?? "",
    recipient.city ?? "",
    recipient.country ?? "DE",
    sender.name,
    sender.street,
    sender.houseNumber,
    sender.postalCode,
    sender.city,
    sender.country,
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(";");

  return {
    sender,
    recipient,
    sizeCategory,
    itemReference,
    missingFields: missing,
    summary,
    csvLine: csv,
  };
}
