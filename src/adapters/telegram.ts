import TelegramBot from "node-telegram-bot-api";
import type { ToolCall } from "../tools/types.ts";
import { getOrCreateSession, saveSession } from "../memory/store.ts";
import { runAgentToolLoop } from "../core/toolloop.ts";
import { logEvent, classifyError } from "../logger.ts";

function parseAllowedChatIds(): Set<number> | null {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return new Set(ids);
}

function shortJson(x: any) {
  const s = JSON.stringify(x, null, 2);
  // Telegram message limit is ~4096 chars; keep it safe
  return s.length > 3500 ? s.slice(0, 3500) + "\n...TRUNCATED..." : s;
}

export type TelegramAdapterOptions = {
  token: string;
};

export async function startTelegramAdapter(opts: TelegramAdapterOptions) {
  const allowed = parseAllowedChatIds();

  const bot = new TelegramBot(opts.token, {
    polling: true,
  });

  // pending approvals: key -> resolver
  const pending = new Map<
    string,
    { resolve: (v: boolean) => void; chatId: number; messageId: number; call: ToolCall }
  >();

  bot.on("message", async (msg) => {
    try {
      const chatId = msg.chat.id;
      const text = (msg.text ?? "").trim();

      if (!text) return;

      if (allowed && !allowed.has(chatId)) {
        await bot.sendMessage(chatId, "Not allowed.");
        return;
      }

      if (text === "/start" || text === "/help") {
        await bot.sendMessage(
          chatId,
          [
            "OpenClaw-Agent Bot",
            "",
            "Commands:",
            "/help - show help",
            "/dev <text> - route to DEV model (Claude)",
            "",
            "Normal messages use default model (Grok).",
            "Tool requests will ask for approval with buttons.",
          ].join("\n"),
        );
        return;
      }

      const isDev = text.startsWith("/dev ");
      const input = isDev ? text.replace(/^\/dev\s+/, "") : text;

      const purpose = isDev ? "dev" : "default";
      const sessionId = `tg-${chatId}`;

      const session = await getOrCreateSession(sessionId);

      await bot.sendMessage(chatId, `🧠 Working… (session ${sessionId}, ${purpose})`);

      const approve = async (call: ToolCall) => {
        const key = `${chatId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

        const approveData = `approve:${key}`;
        const denyData = `deny:${key}`;

        const sent = await bot.sendMessage(
          chatId,
          `🔧 TOOL REQUEST\n\`\`\`\n${shortJson(call)}\n\`\`\`\nApprove?`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Approve", callback_data: approveData },
                  { text: "❌ Deny", callback_data: denyData },
                ],
              ],
            },
          },
        );

        return await new Promise<boolean>((resolve) => {
          pending.set(key, { resolve, chatId, messageId: sent.message_id, call });
        });
      };

      const res = await runAgentToolLoop(session, {
        purpose,
        input,
        maxSteps: 3,
        approve,
      });

      await saveSession(session);

      await logEvent({
        level: "info",
        event: "telegram_done",
        session: session.id,
        purpose,
        provider: res.provider,
        model: res.model,
      });

      await bot.sendMessage(chatId, `✅ [${res.provider}/${res.model}]\n\n${res.text}`);
    } catch (e: any) {
      await logEvent({
        level: "error",
        event: "telegram_error",
        errorClass: classifyError(e),
        message: String(e?.message ?? e),
      });

      // try to respond to chat if possible
      try {
        const chatId = msg.chat.id;
        await bot.sendMessage(chatId, `❗ Error: ${String(e?.message ?? e)}`);
      } catch {}
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

      const ok = action === "approve";
      pending.delete(key);

      await bot.answerCallbackQuery(q.id, { text: ok ? "Approved" : "Denied" });

      // Update original approval message
      await bot.editMessageText(
        `🔧 TOOL REQUEST (${ok ? "APPROVED ✅" : "DENIED ❌"})\n\`\`\`\n${shortJson(p.call)}\n\`\`\``,
        {
          chat_id: p.chatId,
          message_id: p.messageId,
          parse_mode: "Markdown",
        },
      );

      p.resolve(ok);
    } catch (e) {
      // don't crash adapter on callback errors
      try {
        await bot.answerCallbackQuery((q as any).id, { text: "Error." });
      } catch {}
    }
  });

  await logEvent({ level: "info", event: "telegram_started" });
  console.log("Telegram adapter started (polling).");
}
