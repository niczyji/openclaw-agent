// src/adapters/telegram.ts
import TelegramBot from "node-telegram-bot-api";
import { sendLongMessage } from "./telegram-utils.js";

import { getOrCreateSession, saveSession } from "../memory/store.js";
import { deleteSession } from "../memory/sessions.js";
import { runAgentToolLoop } from "../core/toolloop.js";
import { logEvent, classifyError } from "../logger.js";

type StartTelegramAdapterOpts = {
  token: string;
};

// ========= Helpers (kleine Hilfsfunktionen) =========

function parseIds(envName: string): Set<number> | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;

  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  return new Set(ids);
}

function rateLimitSeconds(): number {
  const n = Number(process.env.TELEGRAM_RATE_LIMIT_SECONDS ?? "0");
  return Number.isFinite(n) ? n : 0;
}

function showUsage(): boolean {
  return (process.env.TELEGRAM_SHOW_USAGE ?? "").trim() === "1";
}

function approvalTtlMs(): number {
  const s = Number(process.env.TELEGRAM_APPROVAL_TTL_SECONDS ?? "600");
  return Number.isFinite(s) ? s * 1000 : 600_000;
}

function numEnv(name: string): number | null {
  const v = (process.env[name] ?? "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize usage to a stable shape for Telegram logging/footer & cost calc.
 * Returns null if missing/unknown.
 */
function normalizeUsageAny(
  u: any,
): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  if (!u) return null;

  // Your current internal shape
  if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
    const total =
      typeof u.totalTokens === "number"
        ? u.totalTokens
        : u.inputTokens + u.outputTokens;
    return {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      totalTokens: total,
    };
  }

  // OpenAI chat.completions style
  if (
    typeof u.prompt_tokens === "number" &&
    typeof u.completion_tokens === "number"
  ) {
    const total =
      typeof u.total_tokens === "number"
        ? u.total_tokens
        : u.prompt_tokens + u.completion_tokens;
    return {
      inputTokens: u.prompt_tokens,
      outputTokens: u.completion_tokens,
      totalTokens: total,
    };
  }

  // Responses/Anthropic-ish style
  if (
    typeof u.input_tokens === "number" &&
    typeof u.output_tokens === "number"
  ) {
    const total =
      typeof u.total_tokens === "number"
        ? u.total_tokens
        : u.input_tokens + u.output_tokens;
    return {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      totalTokens: total,
    };
  }

  return null;
}

function estimateCostUsd(
  provider: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null,
): number | null {
  if (!usage) return null;

  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;

  let inRate: number | null = null;
  let outRate: number | null = null;

  // Rates are USD per 1M tokens
  if (provider === "grok") {
    inRate = numEnv("COST_GROK_USD_PER_1M_IN");
    outRate = numEnv("COST_GROK_USD_PER_1M_OUT");
  } else if (provider === "anthropic") {
    inRate = numEnv("COST_ANTHROPIC_USD_PER_1M_IN");
    outRate = numEnv("COST_ANTHROPIC_USD_PER_1M_OUT");
  }

  if (inRate == null || outRate == null) return null;
  return (inTok / 1e6) * inRate + (outTok / 1e6) * outRate;
}

function shortJson(x: any): string {
  const s = JSON.stringify(x, null, 2);
  return s.length > 3500 ? s.slice(0, 3500) + "\n...TRUNCATED..." : s;
}

// ========= Main Adapter =========

export async function startTelegramAdapter(opts: StartTelegramAdapterOpts) {
  const allowed = parseIds("TELEGRAM_ALLOWED_CHAT_IDS");
  const admins = parseIds("TELEGRAM_ADMIN_CHAT_IDS") ?? new Set<number>();

  const cooldownSec = rateLimitSeconds();
  const showUsageFlag = showUsage();
  const ttlMs = approvalTtlMs();

  const lastSeen = new Map<number, number>();
  const bot = new TelegramBot(opts.token, { polling: true });

  const pending = new Map<
    string,
    {
      resolve: (ok: boolean) => void;
      chatId: number;
      messageId: number;
      call: any;
      createdAt: number;
    }
  >();

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();

    try {
      // Access control
      if (allowed && !allowed.has(chatId)) {
        await sendLongMessage(bot, chatId, "Not allowed.");
        return;
      }
      if (!text) return;

      // Cooldown
      if (
        cooldownSec > 0 &&
        !text.startsWith("/help") &&
        !text.startsWith("/start") &&
        !text.startsWith("/id") &&
        !text.startsWith("/reset")
      ) {
        const now = Date.now();
        const last = lastSeen.get(chatId) ?? 0;
        if (now - last < cooldownSec * 1000) {
          await sendLongMessage(
            bot,
            chatId,
            `⏳ Cooldown: please wait ${cooldownSec}s between requests.`,
          );
          return;
        }
        lastSeen.set(chatId, now);
      }

      // Commands
      if (text === "/start" || text === "/help") {
        await sendLongMessage(
          bot,
          chatId,
          [
            "OpenClaw-Agent Bot",
            "",
            "Commands:",
            "/help - show help",
            "/id - show chatId/sessionId",
            "/reset - clear your session",
            "/dev <text> - route to DEV model (Claude)",
            "",
            "Normal messages use default model (Grok).",
            "Tool requests will ask for approval with buttons.",
          ].join("\n"),
        );
        return;
      }

      if (text === "/id") {
        await sendLongMessage(
          bot,
          chatId,
          `chatId: ${chatId}\nsessionId: tg-${chatId}`,
        );
        return;
      }

      if (text === "/reset") {
        const sessionId = `tg-${chatId}`;
        try {
          await deleteSession(sessionId);
          await sendLongMessage(bot, chatId, `🧹 Session reset: ${sessionId}`);
        } catch {
          await sendLongMessage(
            bot,
            chatId,
            `🧹 No session file to delete for: ${sessionId}`,
          );
        }
        return;
      }

      // Route
      const isDev = text.startsWith("/dev ");
      const userInput = isDev ? text.replace(/^\/dev\s+/, "") : text;
      const purpose = isDev ? "dev" : "default";

      const sessionId = `tg-${chatId}`;
      const session = await getOrCreateSession(sessionId);

      await sendLongMessage(
        bot,
        chatId,
        `🧠 Working… (session ${sessionId}, ${purpose})`,
      );

      // Approval function
      const approve = async (call: any): Promise<boolean> => {
        // Admin-only write_file
        if (call.tool === "write_file" && !admins.has(chatId)) {
          await sendLongMessage(
            bot,
            chatId,
            "❌ write_file is restricted to admins.",
          );
          return false;
        }

        const key = `${chatId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

        const sent = await sendLongMessage(
          bot,
          chatId,
          `🔧 TOOL REQUEST\n\`\`\`\n${shortJson(call)}\n\`\`\`\nApprove?`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Approve", callback_data: `approve:${key}` },
                  { text: "❌ Deny", callback_data: `deny:${key}` },
                ],
              ],
            },
          },
        );

        // IMPORTANT: sendLongMessage returns the last Telegram message object (must include message_id)
        const messageId = sent?.message_id;
        if (typeof messageId !== "number") {
          // Fallback: if something went weird, deny safely
          await sendLongMessage(
            bot,
            chatId,
            "❗ Internal error: could not create approval message.",
          );
          return false;
        }

        return await new Promise<boolean>((resolve) => {
          pending.set(key, {
            resolve,
            chatId,
            messageId,
            call,
            createdAt: Date.now(),
          });
        });
      };

      const res = await runAgentToolLoop(session, {
        purpose,
        input: userInput,
        maxSteps: 3,
        approve,
      });

      await saveSession(session);

      const usageNorm = normalizeUsageAny((res as any).usage);

      await logEvent({
        level: "info",
        event: "telegram_done",
        session: session.id,
        purpose,
        provider: (res as any).provider,
        model: (res as any).model,
        details: { usage: usageNorm },
      });

      let footer = "";
      if (showUsageFlag && usageNorm?.totalTokens != null) {
        const cost = estimateCostUsd((res as any).provider, usageNorm);
        const costStr = cost == null ? "" : ` • est=$${cost.toFixed(6)}`;
        footer = `\n\n📊 tokens: in=${usageNorm.inputTokens} out=${usageNorm.outputTokens} total=${usageNorm.totalTokens}${costStr}`;
      }

      await sendLongMessage(
        bot,
        chatId,
        `✅ [${(res as any).provider}/${(res as any).model}]\n\n${(res as any).text}${footer}`,
      );
    } catch (e: any) {
      await logEvent({
        level: "error",
        event: "telegram_error",
        errorClass: classifyError(e),
        message: String(e?.message ?? e),
      });

      await sendLongMessage(
        bot,
        chatId,
        `❗ Error: ${String(e?.message ?? e)}`,
      );
    }
  });

  bot.on("callback_query", async (q) => {
    try {
      if (!q.data || !q.message) return;

      const chatId = q.message.chat.id;

      if (allowed && !allowed.has(chatId)) {
        await bot.answerCallbackQuery(q.id, { text: "Not allowed." });
        return;
      }

      const [action, key] = q.data.split(":", 2);
      if (!key) return;

      const p = pending.get(key);
      if (!p) {
        await bot.answerCallbackQuery(q.id, { text: "Expired." });
        return;
      }

      // TTL check
      if (Date.now() - p.createdAt > ttlMs) {
        pending.delete(key);
        await bot.answerCallbackQuery(q.id, { text: "Expired (timeout)." });
        return;
      }

      const ok = action === "approve";
      pending.delete(key);

      await bot.answerCallbackQuery(q.id, { text: ok ? "Approved" : "Denied" });

      // Update the approval message (nice UX)
      await bot.editMessageText(
        `🔧 TOOL REQUEST (${ok ? "APPROVED ✅" : "DENIED ❌"})\n\`\`\`\n${shortJson(
          p.call,
        )}\n\`\`\``,
        { chat_id: p.chatId, message_id: p.messageId, parse_mode: "Markdown" },
      );

      p.resolve(ok);
    } catch (e: any) {
      try {
        await bot.answerCallbackQuery(q.id, { text: "Error." });
      } catch {}
    }
  });

  await logEvent({ level: "info", event: "telegram_started" });
  console.log("Telegram adapter started (polling).");
}
