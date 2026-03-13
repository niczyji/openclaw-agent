export type KleinanzeigenIntent =
  | "cancellation"
  | "price_negotiation"
  | "availability_question"
  | "meeting_request"
  | "general_interest"
  | "positive_feedback"
  | "payment_issue"
  | "unknown";

export type KleinanzeigenMessage = {
  source: "kleinanzeigen";
  type: "buyer_message";
  itemTitle: string;
  itemId: string | null;
  senderName: string | null;
  messageText: string;
  receivedAt: string | null;
  subject: string | null;
  intent: KleinanzeigenIntent;
};
