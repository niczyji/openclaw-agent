// src/features/verkaufpilot/ai/generateReplySuggestion.ts
//
// Generates a structured sales reply suggestion for a Kleinanzeigen buyer message.
// Uses Grok (grok-3-mini) for cheap, fast sales-copy generation.
// Provider can be switched later without changing calling code.

import { grokChat } from "../../../providers/grok.js";
import type { LlmMessage } from "../../../core/types.js";

// ---------------------------------------------------------------------------
// Sales strategy system prompt
// (kept verbatim from product spec — do not shorten or rephrase)
// ---------------------------------------------------------------------------

const SALES_SYSTEM_PROMPT = `VERKAUFSSTRATEGIE MIT CLOSING-CTA (KLEINANZEIGEN / FB MARKETPLACE)
Du bist mein strategischer Verkaufsberater für eBay Kleinanzeigen und Facebook Marketplace.
Ich verkaufe neue oder gebrauchte Produkte (meist Technik, Gaming, Hardware, Audio).
Deine Aufgabe:
Analysiere jede Nachricht eines Käufers taktisch.
Erkenne Verhandlungsmuster (Lowball, Unsicherheit, Testen, echtes Interesse).
Formuliere kurze, souveräne Antworten.
Halte Preisstabilität, außer ich entscheide anders.
Bringe jedes Gespräch aktiv Richtung Abschluss.
Jede Antwort muss einen klaren Call-to-Action enthalten.
Wichtige Closing-Regeln:
Immer aktiv abschließen.
Stelle konkrete Entscheidungsfragen.
Biete maximal zwei klare Zahlungsoptionen.
Fordere aktiv Adresse oder Zahlungsbestätigung an.
Kommuniziere Versandgeschwindigkeit als Vorteil.
Beispiel-CTAs:
„Möchtest du per PayPal oder Überweisung zahlen?"
„Schick mir bitte deine Adresse, dann mache ich alles fertig."
„Mein PayPal: michal.a.grajoszek@gmail.com Sobald das Geld da ist, geht es direkt raus."
„Passt das für dich? Dann können wir es fix machen."
„Wenn du willst, reserviere ich es dir heute noch."
Arbeitsweise:
Ich sende:
Produkt
Zustand
Wunschpreis
Untergrenze
Käufernachricht
Mein Ziel (max Profit / schneller Verkauf)
Du antwortest mit:
Kurze Analyse der Situation
Fertige Copy-Paste Antwort
Optional zweite Variante (härter oder freundlicher)
Ziel: Nicht nett wirken.
Nicht diskutieren.
Abschließen.

WICHTIG: Antworte IMMER in genau diesem Format (keine Abweichungen):
ANALYSE: [Deine taktische Kurzanalyse, 1-2 Sätze]
ANTWORT: [Deine fertige Copy-Paste Antwort auf Deutsch]
ALTERNATIV: [Optional: zweite Variante oder leer lassen]`;

// ---------------------------------------------------------------------------
// Intent labels for the prompt
// ---------------------------------------------------------------------------

const INTENT_LABELS_DE: Record<string, string> = {
  cancellation: "Käufer sagt ab",
  price_negotiation: "Preisverhandlung / Lowball",
  availability_question: "Verfügbarkeitsanfrage",
  meeting_request: "Abholungs- / Treffennanfrage",
  general_interest: "Allgemeines Kaufinteresse",
  positive_feedback: "Positives Feedback nach Kauf",
  payment_issue: "Zahlungsproblem / Reklamation",
  unknown: "Unbekannt",
};

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export type ReplySuggestion = {
  analysis: string | null;
  replyMain: string;
  replyAlt: string | null;
  model: string;
  provider: string;
  rawResponse: string;
};

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse the structured LLM response into separate fields.
 * Expected format:
 *   ANALYSE: ...
 *   ANTWORT: ...
 *   ALTERNATIV: ...
 *
 * Falls back gracefully if the model doesn't follow the format exactly.
 */
function parseResponse(raw: string): Pick<ReplySuggestion, "analysis" | "replyMain" | "replyAlt"> {
  const extract = (marker: string): string | null => {
    // Match "MARKER: content" until the next known marker or end of string
    const pattern = new RegExp(
      `${marker}:\\s*([\\s\\S]*?)(?=\\n(?:ANALYSE|ANTWORT|ALTERNATIV):|$)`,
      "i",
    );
    const match = raw.match(pattern);
    return match?.[1]?.trim() || null;
  };

  const analysis = extract("ANALYSE");
  const replyMain = extract("ANTWORT");
  const replyAlt = extract("ALTERNATIV");

  // If the format wasn't followed, treat the whole response as the main reply
  if (!replyMain) {
    return { analysis: null, replyMain: raw.trim(), replyAlt: null };
  }

  return {
    analysis: analysis || null,
    replyMain,
    replyAlt: replyAlt && replyAlt.length > 2 ? replyAlt : null,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export type GenerateReplyInput = {
  itemTitle: string;
  senderName: string | null;
  messageText: string;
  intent: string;
};

export async function generateReplySuggestion(
  input: GenerateReplyInput,
): Promise<ReplySuggestion> {
  const intentLabel = INTENT_LABELS_DE[input.intent] ?? input.intent;

  const userPrompt = [
    `Produkt: ${input.itemTitle}`,
    `Käufername: ${input.senderName ?? "unbekannt"}`,
    `Erkannter Intent: ${intentLabel}`,
    ``,
    `Käufernachricht:`,
    `"${input.messageText}"`,
  ].join("\n");

  const messages: LlmMessage[] = [
    { role: "system", content: SALES_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const res = await grokChat({
    provider: "grok",
    model: "grok-3-mini",
    messages,
    maxOutputTokens: 600,
    temperature: 0.4, // slight creativity for sales copy, still consistent
  });

  const parsed = parseResponse(res.text);

  return {
    ...parsed,
    model: res.model ?? "grok-3-mini",
    provider: res.provider ?? "grok",
    rawResponse: res.text,
  };
}
