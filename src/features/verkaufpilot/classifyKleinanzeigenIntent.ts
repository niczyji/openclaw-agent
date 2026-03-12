import type { KleinanzeigenIntent } from "./types.js";

/**
 * Simple rule-based intent classifier for Kleinanzeigen messages.
 */
export function classifyKleinanzeigenIntent(
  messageText: string,
): KleinanzeigenIntent {
  const text = messageText.trim().toLowerCase();

  if (!text) {
    return "unknown";
  }

  if (
    /angekommen|danke|tolle abwicklung|super|alles gut|perfekt|top/.test(text)
  ) {
    return "positive_feedback";
  }

  if (
    /komm ich nicht hin|komme ich nicht hin|doch nicht|sorry|leider nicht|passt nicht|kein interesse/.test(
      text,
    )
  ) {
    return "cancellation";
  }

  if (
    /letzte preis|was letzte preis|preis|vb|verhandelbar|weniger|inkl versand|für \d+/.test(
      text,
    )
  ) {
    return "price_negotiation";
  }

  if (/noch da|verfügbar|available/.test(text)) {
    return "availability_question";
  }

  if (
    /abholen|abholung|treffen|wann passt|adresse|heute|morgen|uhrzeit/.test(
      text,
    )
  ) {
    return "meeting_request";
  }

  if (
    /interesse|nehme ich|würde ich nehmen|möchte ich kaufen|kann ich kaufen/.test(
      text,
    )
  ) {
    return "general_interest";
  }

  return "unknown";
}
