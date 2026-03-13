import type { KleinanzeigenIntent } from "./types.js";

/**
 * Rule-based intent classifier for Kleinanzeigen buyer messages.
 *
 * Priority order matters: more specific intents are checked first.
 * All patterns are tested against lowercased, trimmed text.
 */
export function classifyKleinanzeigenIntent(
  messageText: string,
): KleinanzeigenIntent {
  const text = messageText.trim().toLowerCase();

  if (!text) return "unknown";

  // --- payment_issue ---
  // Buyer reports payment not received, damage, fraud suspicion, or dispute.
  // Checked FIRST to prevent ambiguous words like "angekommen" being
  // classified as positive_feedback when used in a negative context.
  if (
    /geld kam nicht an|zahlung nicht erhalten|nicht bezahlt|überweisung|habe bezahlt|schon überwiesen|betrug|beschädigt|defekt|kaputt|nicht wie beschrieben|falsch geliefert|reklamation|rückerstattung|zurückbuchen|nichts angekommen|nicht angekommen/.test(
      text,
    )
  ) {
    return "payment_issue";
  }

  // --- positive_feedback ---
  // Buyer confirms receipt or praises the transaction.
  if (
    /angekommen|danke|tolle abwicklung|alles gut|perfekt|reibungslos|top verkäufer|hat geklappt|war super/.test(
      text,
    )
  ) {
    return "positive_feedback";
  }

  // --- cancellation ---
  // Buyer cancels, drops out, or is no longer interested.
  if (
    /komm(e)? (ich )?nicht hin|doch nicht|leider nicht|passt (mir |leider )?nicht|kein interesse( mehr)?|absage|abgesagt|klappt (leider )?nicht|hab(e)? es (schon )?gekauft|nehme (es )?nicht mehr|habe mich anders entschieden/.test(
      text,
    )
  ) {
    return "cancellation";
  }

  // --- price_negotiation ---
  // Buyer asks for a lower price or makes a counter-offer.
  if (
    /letzt(e[rn]?)? preis|was (ist der )?letzte preis|\bvb\b|verhandelbar|geht (da )?noch was|kannst du.*preis|geh(e|st) du (auf|mit)|\binkl\.?\s*versand\b|inkl(usive)? versand|für \d+\s*(€|euro)|nehme (es )?für|biete \d+|schaffst du \d+/.test(
      text,
    )
  ) {
    return "price_negotiation";
  }

  // --- availability_question ---
  // Buyer asks if the item is still available.
  if (/noch da|noch verfügbar|noch zu haben|ist (es|der|die|das) noch|\bavailable\b/.test(text)) {
    return "availability_question";
  }

  // --- meeting_request ---
  // Buyer asks about pickup logistics or proposes a meeting time.
  if (
    /abholung|abholen|ab(ge)?holen|treffen|wann (passt|kann ich|können wir)|adresse|wo (bist|wohnst)|heute|morgen|übermorgen|uhrzeit|um \d+\s*(uhr|h\b)|wochentag|wochenende/.test(
      text,
    )
  ) {
    return "meeting_request";
  }

  // --- general_interest ---
  // Buyer expresses clear purchase intent without a specific sub-request.
  if (
    /\binteresse\b|nehme (es|ihn|sie|das)|ich (würde|will|möchte) (es |ihn |sie |das )?(kaufen|nehmen|haben)|deal|ich kaufe|reservier|kannst du (es |mir )?reservieren/.test(
      text,
    )
  ) {
    return "general_interest";
  }

  return "unknown";
}
