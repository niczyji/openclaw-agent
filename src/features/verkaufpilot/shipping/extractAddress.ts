// src/features/verkaufpilot/shipping/extractAddress.ts
//
// Extracts a structured shipping address from a buyer's message text
// using a Grok LLM call with a JSON-extraction prompt.
//
// Returns null fields for any address component the buyer hasn't provided.
// The caller should flag missing fields to the user before shipping.

import { grokChat } from "../../../providers/grok.js";
import type { LlmMessage } from "../../../core/types.js";

export type ExtractedAddress = {
  recipientName: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
};

const SYSTEM_PROMPT = `You are a shipping address extractor.
Extract a shipping/delivery address from the user's message.
Return ONLY a JSON object with these exact keys (use null for missing fields):
{
  "recipientName": string | null,
  "street": string | null,
  "houseNumber": string | null,
  "postalCode": string | null,
  "city": string | null,
  "country": string | null
}

Rules:
- If street and house number are combined (e.g. "Musterstraße 12"), split them.
- country: use ISO 3166-1 alpha-2 code (e.g. "DE", "AT", "CH"). Default to "DE" if not mentioned.
- Do not invent values. Return null for anything not clearly present.
- Output ONLY the JSON object, no explanation, no markdown.`;

/**
 * Parse Grok's JSON response, tolerating markdown code fences.
 */
function parseJson(raw: string): ExtractedAddress {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    const obj = JSON.parse(cleaned);
    return {
      recipientName: obj.recipientName ?? null,
      street: obj.street ?? null,
      houseNumber: obj.houseNumber ?? null,
      postalCode: obj.postalCode ?? null,
      city: obj.city ?? null,
      country: obj.country ?? null,
    };
  } catch {
    // Fallback: return all-null if the model didn't follow the format
    return {
      recipientName: null,
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      country: null,
    };
  }
}

export async function extractAddress(
  messageText: string,
): Promise<ExtractedAddress> {
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: messageText },
  ];

  const res = await grokChat({
    provider: "grok",
    model: "grok-3-mini",
    messages,
    maxOutputTokens: 200,
    temperature: 0.0, // deterministic extraction
  });

  return parseJson(res.text);
}
