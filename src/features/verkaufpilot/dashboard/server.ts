// src/features/verkaufpilot/dashboard/server.ts
//
// Minimal read-only local dashboard for VerkaufPilot.
// Serves server-side rendered HTML via node:http — no framework, no bundler.
//
// Routes:
//   GET /                     — inbox list (all messages or filtered by ?status=)
//   GET /message/:id          — detail view: full message + latest suggestion
//
// Start with: npm run dashboard
// Then open:  http://localhost:3001

import http from "node:http";
import { URL } from "node:url";
import {
  getAllMessages,
  getMessagesByStatus,
  type MessageRecord,
  type MessageStatus,
} from "../db/messageRepo.js";
import { getLatestSuggestionForMessage } from "../db/suggestionRepo.js";
import { getParcelPrepForMessage, getShippingAddressForMessage } from "../db/shippingRepo.js";
import { getDb } from "../db/db.js";

const PORT = 3001;

// ---------------------------------------------------------------------------
// Intent label map (matches telegram/vpCommands.ts)
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

const STATUS_LABELS: Record<string, string> = {
  new: "Neu",
  suggested: "Vorschlag generiert",
  replied: "Beantwortet",
  closed: "Geschlossen",
  paid: "Bezahlt",
  shipped: "Versendet",
};

// Status badge colors (CSS class names)
const STATUS_COLOR: Record<string, string> = {
  new: "badge-new",
  suggested: "badge-suggested",
  replied: "badge-replied",
  closed: "badge-closed",
  paid: "badge-paid",
  shipped: "badge-shipped",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

function stripItemTitle(subject: string | null): string {
  if (!subject) return "–";
  return subject
    .replace(/^Re:\s*/i, "")
    .replace(/^Nutzer-Anfrage zu deiner Anzeige\s*/i, "")
    .replace(/^["""]|["""]$/g, "")
    .trim() || "–";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Look up a single message by id. */
function getMessageById(id: number): MessageRecord | null {
  return (
    (getDb()
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as MessageRecord | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------
// Shared CSS + page shell
// ---------------------------------------------------------------------------

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    background: #f5f5f5;
    color: #1a1a1a;
    line-height: 1.5;
  }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }

  header {
    background: #1a1a2e;
    color: #fff;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  header h1 { font-size: 16px; font-weight: 600; letter-spacing: 0.03em; }
  header .subtitle { color: #aaa; font-size: 12px; }

  .container { max-width: 1100px; margin: 0 auto; padding: 20px 24px; }

  /* Filter bar */
  .filter-bar {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
    align-items: center;
  }
  .filter-bar span { color: #555; font-size: 12px; }
  .filter-btn {
    padding: 4px 12px;
    border-radius: 20px;
    border: 1px solid #ddd;
    background: #fff;
    color: #333;
    cursor: pointer;
    font-size: 12px;
    text-decoration: none;
  }
  .filter-btn:hover { background: #f0f0f0; text-decoration: none; }
  .filter-btn.active { background: #1a1a2e; color: #fff; border-color: #1a1a2e; }

  /* Table */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th { background: #f0f0f0; text-align: left; padding: 10px 12px; font-size: 12px; font-weight: 600; color: #555; white-space: nowrap; border-bottom: 1px solid #e0e0e0; }
  td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #fafafa; }

  .id-col { color: #888; font-size: 12px; width: 40px; }
  .preview-col { color: #555; font-size: 12px; max-width: 300px; }
  .date-col { color: #888; font-size: 12px; white-space: nowrap; }
  .name-col { white-space: nowrap; }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge-new      { background: #dbeafe; color: #1d4ed8; }
  .badge-suggested{ background: #fef9c3; color: #854d0e; }
  .badge-replied  { background: #dcfce7; color: #166534; }
  .badge-closed   { background: #f3f4f6; color: #6b7280; }
  .badge-paid     { background: #d1fae5; color: #065f46; font-weight: 700; }
  .badge-shipped  { background: #e0f2fe; color: #0369a1; font-weight: 700; }
  .badge-intent   { background: #f3e8ff; color: #6b21a8; }

  .empty { text-align: center; color: #888; padding: 40px; }

  /* Detail view */
  .back-link { display: inline-block; margin-bottom: 16px; font-size: 13px; }
  .card {
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
    margin-bottom: 16px;
    overflow: hidden;
  }
  .card-header {
    background: #f7f7f7;
    border-bottom: 1px solid #eee;
    padding: 10px 16px;
    font-size: 12px;
    font-weight: 600;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .card-body { padding: 16px; }
  .field { margin-bottom: 12px; }
  .field:last-child { margin-bottom: 0; }
  .field-label { font-size: 11px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .field-value { font-size: 14px; }
  .field-value.message-text {
    background: #f9f9f9;
    border-left: 3px solid #e0e0e0;
    padding: 10px 12px;
    border-radius: 0 4px 4px 0;
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .field-value.reply-text {
    background: #f0fdf4;
    border-left: 3px solid #86efac;
    padding: 10px 12px;
    border-radius: 0 4px 4px 0;
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .field-value.alt-text {
    background: #fffbeb;
    border-left: 3px solid #fcd34d;
    padding: 10px 12px;
    border-radius: 0 4px 4px 0;
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .no-suggestion { color: #888; font-style: italic; font-size: 13px; }
  .meta-row { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 0; }
  .meta-item { }
`;

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — VerkaufPilot</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <div>
      <h1>🛒 VerkaufPilot</h1>
      <div class="subtitle">Read-only dashboard</div>
    </div>
  </header>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Inbox page
// ---------------------------------------------------------------------------

const VALID_STATUSES: MessageStatus[] = ["new", "suggested", "replied", "closed", "paid", "shipped"];

function renderInbox(statusFilter: string | null): string {
  const messages =
    statusFilter && VALID_STATUSES.includes(statusFilter as MessageStatus)
      ? getMessagesByStatus(statusFilter as MessageStatus)
      : getAllMessages();

  const filterBar = `
    <div class="filter-bar">
      <span>Filter:</span>
      <a href="/" class="filter-btn ${!statusFilter ? "active" : ""}">Alle</a>
      ${VALID_STATUSES.map(
        (s) =>
          `<a href="/?status=${s}" class="filter-btn ${statusFilter === s ? "active" : ""}">${STATUS_LABELS[s] ?? s}</a>`,
      ).join("")}
    </div>`;

  if (messages.length === 0) {
    return pageShell(
      "Posteingang",
      filterBar + `<div class="empty">Keine Nachrichten gefunden.</div>`,
    );
  }

  const rows = messages
    .map((m) => {
      const title = esc(truncate(stripItemTitle(m.subject), 50));
      const preview = esc(truncate(m.message_text, 80));
      const intentLabel = INTENT_LABELS[m.intent] ?? m.intent;
      const statusLabel = STATUS_LABELS[m.status] ?? m.status;
      const statusClass = STATUS_COLOR[m.status] ?? "badge-new";

      return `<tr>
        <td class="id-col">#${m.id}</td>
        <td><a href="/message/${m.id}">${title}</a></td>
        <td class="name-col">${esc(m.sender_name ?? "–")}</td>
        <td><span class="badge badge-intent">${esc(intentLabel)}</span></td>
        <td><span class="badge ${statusClass}">${esc(statusLabel)}</span></td>
        <td class="preview-col">${preview}</td>
        <td class="date-col">${formatDate(m.received_at)}</td>
      </tr>`;
    })
    .join("");

  const table = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Artikel / Betreff</th>
            <th>Käufer</th>
            <th>Intent</th>
            <th>Status</th>
            <th>Vorschau</th>
            <th>Datum</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const heading = `<h2 style="margin-bottom:12px;font-size:16px;">
    Posteingang
    <span style="color:#888;font-weight:normal;font-size:13px;">(${messages.length} Nachrichten${statusFilter ? ` · ${STATUS_LABELS[statusFilter] ?? statusFilter}` : ""})</span>
  </h2>`;

  return pageShell("Posteingang", heading + filterBar + table);
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

function renderDetail(id: number): string {
  const msg = getMessageById(id);
  if (!msg) {
    return pageShell("Nicht gefunden", `<a class="back-link" href="/">← Zurück</a><div class="empty">Nachricht #${id} nicht gefunden.</div>`);
  }

  const suggestion = getLatestSuggestionForMessage(id);
  const title = stripItemTitle(msg.subject);
  const intentLabel = INTENT_LABELS[msg.intent] ?? msg.intent;
  const statusLabel = STATUS_LABELS[msg.status] ?? msg.status;
  const statusClass = STATUS_COLOR[msg.status] ?? "badge-new";

  const metaCard = `
    <div class="card">
      <div class="card-header">Nachricht #${id}</div>
      <div class="card-body">
        <div class="field meta-row">
          <div class="meta-item">
            <div class="field-label">Artikel</div>
            <div class="field-value">${esc(title)}</div>
          </div>
          <div class="meta-item">
            <div class="field-label">Käufer</div>
            <div class="field-value">${esc(msg.sender_name ?? "–")}</div>
          </div>
          <div class="meta-item">
            <div class="field-label">Intent</div>
            <div class="field-value"><span class="badge badge-intent">${esc(intentLabel)}</span></div>
          </div>
          <div class="meta-item">
            <div class="field-label">Status</div>
            <div class="field-value"><span class="badge ${statusClass}">${esc(statusLabel)}</span></div>
          </div>
          <div class="meta-item">
            <div class="field-label">Empfangen</div>
            <div class="field-value">${formatDate(msg.received_at)}</div>
          </div>
          <div class="meta-item">
            <div class="field-label">Importiert</div>
            <div class="field-value">${formatDate(msg.imported_at)}</div>
          </div>
          ${msg.payment_reference ? `<div class="meta-item">
            <div class="field-label">PayPal Verwendungszweck</div>
            <div class="field-value" style="font-family:monospace;font-weight:600;">${esc(msg.payment_reference)}</div>
          </div>` : ""}
        </div>
        <div class="field">
          <div class="field-label">Nachricht</div>
          <div class="field-value message-text">${esc(msg.message_text)}</div>
        </div>
      </div>
    </div>`;

  let suggestionCard: string;
  if (!suggestion) {
    suggestionCard = `
      <div class="card">
        <div class="card-header">Antwortvorschlag</div>
        <div class="card-body">
          <p class="no-suggestion">Noch kein Vorschlag generiert. Nutze <code>/vp suggest ${id}</code> im Telegram-Bot.</p>
        </div>
      </div>`;
  } else {
    const analysisField = suggestion.analysis
      ? `<div class="field">
           <div class="field-label">Analyse</div>
           <div class="field-value">${esc(suggestion.analysis)}</div>
         </div>`
      : "";

    const altField = suggestion.reply_alt
      ? `<div class="field">
           <div class="field-label">Alternative Antwort</div>
           <div class="field-value alt-text">${esc(suggestion.reply_alt)}</div>
         </div>`
      : "";

    const meta = `<div class="field" style="color:#888;font-size:12px;">
      Generiert: ${formatDate(suggestion.generated_at)} · Modell: ${esc(suggestion.model)} · Provider: ${esc(suggestion.provider)}
    </div>`;

    suggestionCard = `
      <div class="card">
        <div class="card-header">Antwortvorschlag #${suggestion.id}</div>
        <div class="card-body">
          ${analysisField}
          <div class="field">
            <div class="field-label">Antwort (copy-paste)</div>
            <div class="field-value reply-text">${esc(suggestion.reply_main)}</div>
          </div>
          ${altField}
          ${meta}
        </div>
      </div>`;
  }

  // Shipping card (optional — only shown if prepare-shipping was run)
  const shippingAddr = getShippingAddressForMessage(id);
  const parcelPrep = getParcelPrepForMessage(id);

  let shippingCard = "";
  if (shippingAddr || parcelPrep) {
    const addrLines = shippingAddr ? [
      shippingAddr.recipient_name ?? "–",
      [shippingAddr.street, shippingAddr.house_number].filter(Boolean).join(" ") || "–",
      [shippingAddr.postal_code, shippingAddr.city].filter(Boolean).join(" ") || "–",
      shippingAddr.country,
    ].join(", ") : "–";

    const trackingField = parcelPrep?.tracking_number
      ? `<div class="field"><div class="field-label">Tracking</div><div class="field-value">${esc(parcelPrep.tracking_number)}</div></div>`
      : "";

    shippingCard = `
      <div class="card">
        <div class="card-header">Versandvorbereitung</div>
        <div class="card-body">
          <div class="field meta-row">
            <div class="meta-item">
              <div class="field-label">Empfängeradresse</div>
              <div class="field-value">${esc(addrLines)}</div>
            </div>
            ${parcelPrep ? `<div class="meta-item">
              <div class="field-label">Paketgröße</div>
              <div class="field-value">${esc(parcelPrep.size_category)}</div>
            </div>` : ""}
            ${parcelPrep ? `<div class="meta-item">
              <div class="field-label">Versandstatus</div>
              <div class="field-value">${esc(parcelPrep.status)}</div>
            </div>` : ""}
          </div>
          ${trackingField}
        </div>
      </div>`;
  }

  return pageShell(
    `#${id} ${title}`,
    `<a class="back-link" href="/">← Posteingang</a>` + metaCard + suggestionCard + shippingCard,
  );
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  try {
    // Detail: /message/:id
    const detailMatch = pathname.match(/^\/message\/(\d+)$/);
    if (detailMatch) {
      const id = parseInt(detailMatch[1]!, 10);
      res.writeHead(200);
      res.end(renderDetail(id));
      return;
    }

    // Inbox: /
    if (pathname === "/" || pathname === "") {
      const statusFilter = url.searchParams.get("status");
      res.writeHead(200);
      res.end(renderInbox(statusFilter));
      return;
    }

    // 404
    res.writeHead(404);
    res.end(pageShell("404", `<div class="empty">Seite nicht gefunden: ${esc(pathname)}</div>`));
  } catch (err: any) {
    console.error("Dashboard error:", err);
    res.writeHead(500);
    res.end(pageShell("Fehler", `<div class="empty">Interner Fehler: ${esc(String(err?.message ?? err))}</div>`));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`VerkaufPilot Dashboard → http://localhost:${PORT}`);
});
