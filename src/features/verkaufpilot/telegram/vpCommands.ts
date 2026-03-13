// src/features/verkaufpilot/telegram/vpCommands.ts
//
// Handles all /vp Telegram commands for VerkaufPilot.
// Deterministic — no LLM involved.

import {
  getAllItems,
  getAllMessages,
  getItemById,
  getMessageById,
  getMessagesByIntent,
  getMessagesByStatus,
  getSummary,
  setPaymentReference,
  updateMessageStatus,
  type ItemRecord,
  type MessageRecord,
} from "../db/messageRepo.js";
import {
  insertSuggestion,
  markSentToTg,
  getLatestSuggestionForMessage,
} from "../db/suggestionRepo.js";
import { generateReplySuggestion } from "../ai/generateReplySuggestion.js";
import { importKleinanzeigenFromGmail } from "../gmail/importKleinanzeigenFromGmail.js";
import { importPaypalFromGmail } from "../gmail/importPaypalFromGmail.js";
import {
  insertShippingAddress,
  insertParcelPrep,
  getShippingAddressForMessage,
  getParcelPrepForMessage,
  setTrackingNumber,
} from "../db/shippingRepo.js";
import { extractAddress } from "../shipping/extractAddress.js";
import { estimateParcelSize } from "../shipping/estimateParcelSize.js";
import {
  prepareHermesData,
  loadSenderAddress,
  CSV_HEADER,
} from "../shipping/prepareHermesData.js";
import { generateShippingReply } from "../shipping/generateShippingReply.js";
import { generatePaymentReference } from "../shipping/generatePaymentReference.js";
import type { KleinanzeigenIntent } from "../types.js";

// ---------------------------------------------------------------------------
// Shared helper: generate + store + send a suggestion for one message
// ---------------------------------------------------------------------------

async function autoSuggest(
  msg: MessageRecord,
  sendMessage: (text: string) => Promise<void>,
): Promise<void> {
  const title =
    msg.subject
      ?.replace(/^Re:\s*/i, "")
      .replace(/^Nutzer-Anfrage zu deiner Anzeige\s*/i, "")
      .replace(/^[""]|[""]$/g, "") ?? msg.subject ?? "Unbekannter Artikel";

  // Generate and persist payment reference if not already set.
  const item = msg.item_id != null ? getItemById(msg.item_id) : null;
  const payRef =
    msg.payment_reference ??
    generatePaymentReference(title, msg.sender_name, msg.id, item?.kleinanzeigen_id);
  if (!msg.payment_reference) {
    setPaymentReference(msg.id, payRef);
  }

  let suggestion;
  try {
    suggestion = await generateReplySuggestion({
      itemTitle: title,
      senderName: msg.sender_name,
      messageText: msg.message_text,
      intent: msg.intent,
    });
  } catch (err: any) {
    await sendMessage(`❌ KI-Fehler für #${msg.id}: ${String(err?.message ?? err)}`);
    return;
  }

  const suggestionId = insertSuggestion({
    messageId: msg.id,
    model: suggestion.model,
    provider: suggestion.provider,
    analysis: suggestion.analysis,
    replyMain: suggestion.replyMain,
    replyAlt: suggestion.replyAlt,
  });

  const card = formatSuggestionCard(
    msg,
    suggestion.analysis,
    suggestion.replyMain,
    suggestion.replyAlt,
    suggestionId,
    payRef,
  );

  await sendMessage(card);
  markSentToTg(suggestionId);
  updateMessageStatus(msg.id, "suggested");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const INTENT_LABELS: Record<string, string> = {
  cancellation: "Absage",
  price_negotiation: "Preisverhandlung",
  availability_question: "Verfügbarkeit?",
  meeting_request: "Abholung/Treffen",
  general_interest: "Kaufinteresse",
  positive_feedback: "Positives Feedback",
  payment_issue: "Zahlungsproblem",
  unknown: "Unbekannt",
};

const ALL_INTENTS: KleinanzeigenIntent[] = [
  "payment_issue",
  "cancellation",
  "price_negotiation",
  "availability_question",
  "meeting_request",
  "general_interest",
  "positive_feedback",
  "unknown",
];

function formatDate(raw: string | null): string {
  if (!raw) return "–";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw.slice(0, 16);
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function formatSummary(): string {
  const { totalMessages, byIntent } = getSummary();
  const items = getAllItems();

  const lines: string[] = [
    "📊 VerkaufPilot Summary",
    "─────────────────────",
    `Messages: ${totalMessages}`,
    `Items:    ${items.length}`,
    "",
    "Intents:",
  ];

  for (const intent of ALL_INTENTS) {
    const count = byIntent[intent];
    if (!count) continue;
    const label = INTENT_LABELS[intent] ?? intent;
    lines.push(`  ${label.padEnd(22)} ${count}`);
  }

  if (totalMessages === 0) {
    lines.push("  (keine Nachrichten importiert)");
  }

  return lines.join("\n");
}

function formatMessageList(messages: MessageRecord[], title: string): string {
  if (messages.length === 0) return `${title}\n\n(keine Ergebnisse)`;

  const lines: string[] = [`${title} (${messages.length})`, ""];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const label = INTENT_LABELS[m.intent] ?? m.intent;
    // Extract item title from subject: strip "Re: Nutzer-Anfrage zu deiner Anzeige " prefix
    const title =
      m.subject?.replace(/^Re:\s*/i, "").replace(/^Nutzer-Anfrage zu deiner Anzeige\s*/i, "").replace(/^[""]|[""]$/g, "") ??
      "–";
    lines.push(`[${i + 1}] ${truncate(title, 48)}`);
    lines.push(`    Von: ${m.sender_name ?? "–"}  •  ${label}`);
    lines.push(`    "${truncate(m.message_text, 75)}"`);
    lines.push(`    📅 ${formatDate(m.received_at)}`);
    if (i < messages.length - 1) lines.push("");
  }

  return lines.join("\n");
}

function formatItemList(items: ItemRecord[]): string {
  if (items.length === 0) return "📦 Artikel\n\n(keine Artikel gefunden)";

  const lines = ["📦 Artikel", ""];
  for (const item of items) {
    lines.push(`• [${item.kleinanzeigen_id ?? "–"}] ${item.title}`);
  }
  return lines.join("\n");
}

/** Format a full suggestion card for Telegram. */
function formatSuggestionCard(
  msg: MessageRecord,
  analysis: string | null,
  replyMain: string,
  replyAlt: string | null,
  suggestionId: number,
  paymentReference?: string | null,
): string {
  const intentLabel = INTENT_LABELS[msg.intent] ?? msg.intent;
  const title =
    msg.subject
      ?.replace(/^Re:\s*/i, "")
      .replace(/^Nutzer-Anfrage zu deiner Anzeige\s*/i, "")
      .replace(/^[""]|[""]$/g, "") ?? "–";

  const lines: string[] = [
    `🛒 Antwortvorschlag #${suggestionId}`,
    `──────────────────────`,
    `📦 ${truncate(title, 50)}`,
    `👤 ${msg.sender_name ?? "–"}  •  ${intentLabel}`,
    `📅 ${formatDate(msg.received_at)}`,
    ``,
    `💬 Nachricht:`,
    `"${truncate(msg.message_text, 200)}"`,
  ];

  if (analysis) {
    lines.push(``, `🧠 Analyse:`, analysis);
  }

  lines.push(``, `📝 Antwort (copy-paste):`, replyMain);

  if (replyAlt) {
    lines.push(``, `📝 Alternative:`, replyAlt);
  }

  const ref = paymentReference ?? msg.payment_reference;
  if (ref) {
    lines.push(``, `💳 PayPal Verwendungszweck: ${ref}`);
  }

  return lines.join("\n");
}

function vpHelp(): string {
  return [
    "🛒 VerkaufPilot Commands",
    "",
    "/vp summary              – Intent-Statistik + Artikel",
    "/vp list                 – Letzte 10 Nachrichten",
    "/vp list <intent>        – Nachrichten nach Intent",
    "/vp items                – Kleinanzeigen-Artikel",
    "/vp pending              – Offene Nachrichten (new/suggested)",
    "/vp suggest <id>         – Antwortvorschlag generieren",
    "/vp mark-replied <id>    – Als beantwortet markieren",
    "/vp close <id>           – Vorgang schließen",
    "/vp import                    – Gmail-Import + auto-suggest (Admin)",
    "/vp import-paypal             – PayPal-Import + Zahlung zuordnen (Admin)",
    "/vp prepare-shipping <id>     – Versandvorbereitung (Adresse + Hermes-Daten)",
    "/vp shipped <id> <tracking>   – Tracking speichern + Status shipped",
    "",
    "Status: new → suggested → replied/closed/paid/shipped",
    "",
    "Intents:",
    ALL_INTENTS.map((i) => `  ${i}`).join("\n"),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle a /vp command.
 * @returns true if the command was handled, false otherwise.
 */
export async function handleVpCommand(
  sendMessage: (text: string) => Promise<void>,
  text: string,
  isAdmin: boolean,
): Promise<boolean> {
  if (!text.startsWith("/vp")) return false;

  const sub = text.slice("/vp".length).trim().toLowerCase();

  // /vp or /vp help
  if (sub === "" || sub === "help") {
    await sendMessage(vpHelp());
    return true;
  }

  // /vp summary
  if (sub === "summary") {
    await sendMessage(formatSummary());
    return true;
  }

  // /vp items
  if (sub === "items") {
    await sendMessage(formatItemList(getAllItems()));
    return true;
  }

  // /vp list [intent]
  if (sub === "list" || sub.startsWith("list ")) {
    const intentArg = sub.slice("list".length).trim();
    if (!intentArg) {
      const messages = getAllMessages().slice(0, 10);
      await sendMessage(formatMessageList(messages, "📋 Letzte Nachrichten"));
    } else {
      const messages = getMessagesByIntent(intentArg);
      const label = INTENT_LABELS[intentArg] ?? intentArg;
      await sendMessage(formatMessageList(messages, `🔍 ${label}`));
    }
    return true;
  }

  // /vp import (admin only)
  if (sub === "import") {
    if (!isAdmin) {
      await sendMessage("❌ /vp import ist Admins vorbehalten.");
      return true;
    }

    await sendMessage("⏳ Gmail-Import läuft…");

    let summary;
    try {
      summary = await importKleinanzeigenFromGmail();
      await sendMessage(
        `✅ Import abgeschlossen: ${summary.imported} neu, ${summary.skipped} übersprungen (${summary.total} gesamt gesehen)`,
      );
    } catch (err: any) {
      await sendMessage(`❌ Import fehlgeschlagen: ${String(err?.message ?? err)}`);
      return true;
    }

    // Auto-generate reply suggestions for every freshly imported message.
    if (summary.newMessageIds.length > 0) {
      await sendMessage(`🤖 Generiere ${summary.newMessageIds.length} Vorschlag(Vorschläge)…`);
      for (const messageId of summary.newMessageIds) {
        const msg = getMessageById(messageId);
        if (msg) await autoSuggest(msg, sendMessage);
      }
    }

    return true;
  }

  // /vp import-paypal (admin only)
  if (sub === "import-paypal") {
    if (!isAdmin) {
      await sendMessage("❌ /vp import-paypal ist Admins vorbehalten.");
      return true;
    }

    await sendMessage("⏳ PayPal-Import läuft…");

    try {
      const result = await importPaypalFromGmail();

      if (result.matched === 0) {
        await sendMessage(
          `ℹ️ PayPal-Import: ${result.total} E-Mails geprüft, keine Übereinstimmung.\n` +
          `(${result.unmatched} nicht zugeordnet)`,
        );
        return true;
      }

      const tierIcon = { exact: "🎯", partial: "🔍", fuzzy: "🤔" } as const;
      const lines: string[] = [
        `💳 PayPal-Import: ${result.matched} Zahlung(en) zugeordnet`,
        `   (${result.matchedExact} exakt · ${result.matchedPartial} teilweise · ${result.matchedFuzzy} fuzzy)`,
        "",
      ];
      for (const p of result.payments) {
        const icon = tierIcon[p.matchTier];
        lines.push(
          `${icon} Nachricht #${p.messageId}  •  ${p.senderName ?? "–"}  •  ${p.amount ?? "?"} ${p.currency ?? ""}`,
        );
        if (p.note) lines.push(`   Verwendungszweck: ${p.note}`);
      }
      if (result.unmatched > 0) lines.push(``, `⚠️ ${result.unmatched} E-Mail(s) nicht zugeordnet.`);

      await sendMessage(lines.join("\n"));
    } catch (err: any) {
      await sendMessage(`❌ PayPal-Import fehlgeschlagen: ${String(err?.message ?? err)}`);
    }

    return true;
  }

  // /vp pending — messages in state 'new' or 'suggested'
  if (sub === "pending") {
    const newMsgs = getMessagesByStatus("new");
    const suggestedMsgs = getMessagesByStatus("suggested");
    const pending = [...newMsgs, ...suggestedMsgs].sort((a, b) =>
      (b.received_at ?? "").localeCompare(a.received_at ?? ""),
    );

    if (pending.length === 0) {
      await sendMessage("✅ Keine offenen Nachrichten.");
      return true;
    }

    const lines: string[] = [`⏳ Offen (${pending.length})`, ""];
    for (const m of pending) {
      const label = INTENT_LABELS[m.intent] ?? m.intent;
      const title =
        m.subject
          ?.replace(/^Re:\s*/i, "")
          .replace(/^Nutzer-Anfrage zu deiner Anzeige\s*/i, "")
          .replace(/^[""]|[""]$/g, "") ?? "–";
      const statusIcon = m.status === "suggested" ? "💬" : "🆕";
      lines.push(`${statusIcon} [${m.id}] ${truncate(title, 38)}  •  ${m.sender_name ?? "–"}  •  ${label}`);
    }
    lines.push("", `→ /vp suggest <id> | /vp mark-replied <id> | /vp close <id>`);

    await sendMessage(lines.join("\n"));
    return true;
  }

  // /vp suggest <id> — generate reply suggestion for a message
  if (sub.startsWith("suggest")) {
    const idStr = sub.slice("suggest".length).trim();
    const messageId = parseInt(idStr, 10);

    if (!idStr || isNaN(messageId)) {
      await sendMessage("Usage: /vp suggest <message_id>\n\nNachricht-IDs: /vp pending oder /vp list");
      return true;
    }

    const msg = getMessageById(messageId);
    if (!msg) {
      await sendMessage(`❌ Nachricht #${messageId} nicht gefunden. Nutze /vp list für gültige IDs.`);
      return true;
    }

    const existing = getLatestSuggestionForMessage(messageId);
    if (existing) {
      await sendMessage(`ℹ️ Vorhandener Vorschlag #${existing.id} vom ${formatDate(existing.generated_at)} wird neu generiert…`);
    } else {
      await sendMessage(`🤖 Generiere Vorschlag für Nachricht #${messageId}…`);
    }

    await autoSuggest(msg, sendMessage);
    return true;
  }

  // /vp mark-replied <id>
  if (sub.startsWith("mark-replied")) {
    const idStr = sub.slice("mark-replied".length).trim();
    const messageId = parseInt(idStr, 10);

    if (!idStr || isNaN(messageId)) {
      await sendMessage("Usage: /vp mark-replied <message_id>");
      return true;
    }

    const msg = getMessageById(messageId);
    if (!msg) {
      await sendMessage(`❌ Nachricht #${messageId} nicht gefunden.`);
      return true;
    }

    updateMessageStatus(messageId, "replied");
    await sendMessage(`✅ Nachricht #${messageId} als beantwortet markiert.`);
    return true;
  }

  // /vp close <id>
  if (sub.startsWith("close")) {
    const idStr = sub.slice("close".length).trim();
    const messageId = parseInt(idStr, 10);

    if (!idStr || isNaN(messageId)) {
      await sendMessage("Usage: /vp close <message_id>");
      return true;
    }

    const msg = getMessageById(messageId);
    if (!msg) {
      await sendMessage(`❌ Nachricht #${messageId} nicht gefunden.`);
      return true;
    }

    updateMessageStatus(messageId, "closed");
    await sendMessage(`🔒 Nachricht #${messageId} geschlossen.`);
    return true;
  }

  // /vp prepare-shipping <id>
  if (sub.startsWith("prepare-shipping")) {
    const idStr = sub.slice("prepare-shipping".length).trim();
    const messageId = parseInt(idStr, 10);

    if (!idStr || isNaN(messageId)) {
      await sendMessage("Usage: /vp prepare-shipping <message_id>");
      return true;
    }

    const msg = getMessageById(messageId);
    if (!msg) {
      await sendMessage(`❌ Nachricht #${messageId} nicht gefunden.`);
      return true;
    }

    await sendMessage(`🔍 Extrahiere Adresse + bereite Hermes-Daten vor…`);

    // Step 1: extract address from buyer message
    let address;
    try {
      address = await extractAddress(msg.message_text);
    } catch (err: any) {
      await sendMessage(`❌ Adressextraktion fehlgeschlagen: ${String(err?.message ?? err)}`);
      return true;
    }

    const addrId = insertShippingAddress({
      messageId,
      recipientName: address.recipientName,
      street: address.street,
      houseNumber: address.houseNumber,
      postalCode: address.postalCode,
      city: address.city,
      country: address.country ?? "DE",
      rawExtracted: msg.message_text,
    });

    // Step 2: estimate parcel size from item title
    const itemTitle =
      msg.subject
        ?.replace(/^Re:\s*/i, "")
        .replace(/^Nutzer-Anfrage zu deiner Anzeige\s*/i, "")
        .replace(/^[""]|[""]$/g, "") ?? "Unbekannter Artikel";

    const sizeCategory = estimateParcelSize(itemTitle);

    insertParcelPrep({
      messageId,
      shippingAddressId: addrId,
      sizeCategory,
      itemReference: itemTitle,
    });

    // Step 3: load sender + assemble Hermes summary
    let sender;
    try {
      sender = loadSenderAddress();
    } catch (err: any) {
      await sendMessage(`❌ Absenderadresse fehlt: ${String(err?.message ?? err)}\nBitte HERMES_SENDER_* in .env setzen.`);
      return true;
    }

    const hermesData = prepareHermesData({
      messageId,
      recipient: address,
      sizeCategory,
      itemReference: itemTitle,
      sender,
    });

    await sendMessage(hermesData.summary);

    // Step 4: generate shipping reply suggestion
    try {
      const reply = await generateShippingReply({
        buyerName: msg.sender_name,
        itemTitle,
      });
      await sendMessage(`📝 Versandnachricht (copy-paste):\n\n${reply.text}`);
    } catch {
      // Non-fatal — shipping summary was already sent
    }

    return true;
  }

  // /vp shipped <id> <trackingNumber>
  if (sub.startsWith("shipped")) {
    const parts = sub.slice("shipped".length).trim().split(/\s+/);
    const messageId = parseInt(parts[0] ?? "", 10);
    const trackingNumber = parts.slice(1).join(" ").trim();

    if (!parts[0] || isNaN(messageId) || !trackingNumber) {
      await sendMessage("Usage: /vp shipped <message_id> <tracking_number>");
      return true;
    }

    const msg = getMessageById(messageId);
    if (!msg) {
      await sendMessage(`❌ Nachricht #${messageId} nicht gefunden.`);
      return true;
    }

    const prep = getParcelPrepForMessage(messageId);
    if (!prep) {
      await sendMessage(`⚠️ Keine Versandvorbereitung für #${messageId}. Erst /vp prepare-shipping ${messageId} ausführen.`);
      return true;
    }

    setTrackingNumber(prep.id, trackingNumber);
    updateMessageStatus(messageId, "shipped");

    // Generate a shipping confirmation message for the buyer
    const itemTitle =
      msg.subject
        ?.replace(/^Re:\s*/i, "")
        .replace(/^Nutzer-Anfrage zu deiner Anzeige\s*/i, "")
        .replace(/^[""]|[""]$/g, "") ?? "Unbekannter Artikel";

    await sendMessage(
      `🚚 Nachricht #${messageId} als versendet markiert.\nTracking: ${trackingNumber}`,
    );

    try {
      const reply = await generateShippingReply({
        buyerName: msg.sender_name,
        itemTitle,
        trackingNumber,
      });
      await sendMessage(`📝 Versandnachricht an Käufer (copy-paste):\n\n${reply.text}`);
    } catch {
      // Non-fatal
    }

    return true;
  }

  // Unknown /vp subcommand
  await sendMessage(`❓ Unbekannter VP-Befehl: /vp ${sub}\n\n${vpHelp()}`);
  return true;
}
