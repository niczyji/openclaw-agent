// src/features/verkaufpilot/shipping/generateShippingReply.ts
//
// Generates a short shipping confirmation reply for the buyer.
// Uses grok-3-mini — cheap, fast, German sales copy.

import { grokChat } from "../../../providers/grok.js";
import type { LlmMessage } from "../../../core/types.js";

export type ShippingReply = {
  text: string;
  model: string;
  provider: string;
};

const SYSTEM_PROMPT = `Du bist ein freundlicher Verkäufer auf eBay Kleinanzeigen.
Schreibe eine kurze, professionelle Versandbestätigung auf Deutsch.
Maximal 3 Sätze.
Erwähne: Zahlung bestätigt, Paket wird heute/morgen versendet, Hermes, Trackingnummer folgt.
Kein "Sehr geehrte/r" — du-Form ist ok.
Antworte NUR mit dem Nachrichtentext, ohne Erklärungen.`;

export async function generateShippingReply(opts: {
  buyerName: string | null;
  itemTitle: string;
  trackingNumber?: string | null;
}): Promise<ShippingReply> {
  const { buyerName, itemTitle, trackingNumber } = opts;

  const userPrompt = [
    `Käufer: ${buyerName ?? "unbekannt"}`,
    `Artikel: ${itemTitle}`,
    trackingNumber ? `Trackingnummer: ${trackingNumber}` : "Trackingnummer: folgt per separater Nachricht",
  ].join("\n");

  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const res = await grokChat({
    provider: "grok",
    model: "grok-3-mini",
    messages,
    maxOutputTokens: 150,
    temperature: 0.3,
  });

  return {
    text: res.text.trim(),
    model: res.model ?? "grok-3-mini",
    provider: res.provider ?? "grok",
  };
}
