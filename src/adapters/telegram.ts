// src/adapters/telegram.ts
import TelegramBot from "node-telegram-bot-api";
import { randomUUID } from "crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sendLongMessage } from "./telegram-utils.js";
import { getOrCreateSession, saveSession } from "../memory/store.js";
import { deleteSession } from "../memory/sessions.js";
import { runAgentToolLoop } from "../core/toolloop.js";
import { logEvent, classifyError } from "../logger.js";

// Builder (deterministic commands)
import { diffOperation } from "../core/builder/diff.js";
import { applyOperation } from "../core/builder/apply.js";
import { rollbackOperation } from "../core/builder/rollback.js";
import { loadOp, saveOp, appendLog } from "../core/builder/store.js";

type StartTelegramAdapterOpts = {
  token: string;
};

// ========= Helpers =========

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

  // Internal shape
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

  // Anthropic-ish / responses-ish style
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

async function findLatestOpId(): Promise<string | null> {
  const dir = path.resolve(process.cwd(), "data/patches/staged");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length === 0) return null;

    // sort by name descending (your opId starts with ISO timestamp, so this works)
    dirs.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    return dirs[0] ?? null;
  } catch {
    return null;
  }
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
    const traceId = randomUUID().slice(0, 8);

    console.log("TG trace", traceId, "message", { chatId, text });

    try {
      // Access control
      if (allowed && !allowed.has(chatId)) {
        await sendLongMessage(bot, chatId, "Not allowed.");
        return;
      }
      if (!text) return;

      // Cooldown (ignore command spam)
      if (
        cooldownSec > 0 &&
        !text.startsWith("/help") &&
        !text.startsWith("/start") &&
        !text.startsWith("/id") &&
        !text.startsWith("/reset") &&
        !text.startsWith("/autopilot") &&
        !text.startsWith("/devon") &&
        !text.startsWith("/devoff")
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

      // Session must exist early (commands need it)
      const sessionId = `tg-${chatId}`;
      const session = await getOrCreateSession(sessionId);
      const s: any = session as any;
      s.meta = s.meta ?? {};

      const devDefault = Boolean(s.meta.devDefault);
      const isDevExplicit = /^\/dev(\s|$)/i.test(text);

      // builderMode musi być policzony zanim użyjesz go w /apply, /rollback itd.
      const builderMode = isDevExplicit || devDefault;
      const purpose: "dev" | "runtime" = builderMode ? "dev" : "runtime";

      const canBuild = purpose === "dev" && admins.has(chatId);
      const autopilotActive = Boolean(s.meta.autopilot) && canBuild;
      // ---------------------------
      // Session toggles
      // ---------------------------

      // /autopilot on|off|status
      if (text === "/autopilot on") {
        if (!admins.has(chatId)) {
          await sendLongMessage(
            bot,
            chatId,
            "❌ autopilot restricted to admins.",
          );
          return;
        }
        s.meta.autopilot = true;
        await saveSession(session);
        await sendLongMessage(bot, chatId, "🤖 autopilot: ON ✅");
        return;
      }

      if (text === "/autopilot on") {
        s.meta.autopilot = true;
        await saveSession(session);
        await sendLongMessage(bot, chatId, "🤖 autopilot: ON ✅");
        return;
      }

      if (text === "/autopilot off") {
        s.meta.autopilot = false;
        await saveSession(session);
        await sendLongMessage(bot, chatId, "🤖 autopilot: OFF ❌");
        return;
      }

      // /devon + /devoff (so you don't have to type /dev every time)
      if (text === "/devon") {
        s.meta.devDefault = true;
        await saveSession(session);
        await sendLongMessage(
          bot,
          chatId,
          "🛠 dev default: ON ✅ (you can omit /dev)",
        );
        return;
      }

      if (text === "/devoff") {
        s.meta.devDefault = false;
        await saveSession(session);
        await sendLongMessage(bot, chatId, "🛠 dev default: OFF ❌");
        return;
      }

      // ---------------------------
      // Deterministic builder commands (no LLM)
      // ---------------------------

      if (text === "/lastop") {
        const latest = await findLatestOpId();
        await sendLongMessage(
          bot,
          chatId,
          latest ? `🧾 latest opId:\n${latest}` : "No staged operations found.",
        );
        return;
      }

      if (text.startsWith("/status ")) {
        const opId = text.split(" ")[1]?.trim();
        if (!opId) {
          await sendLongMessage(bot, chatId, "Usage: /status <opId>");
          return;
        }
        const op = await loadOp(opId);
        await sendLongMessage(
          bot,
          chatId,
          [
            `🧾 opId: ${op.id}`,
            `status: ${op.status}`,
            `createdAt: ${op.createdAt}`,
            `files:`,
            ...op.files.map((f) => `- ${f.targetPath}`),
          ].join("\n"),
        );
        return;
      }

      if (text.startsWith("/diff ")) {
        const opId = text.split(" ")[1]?.trim();
        if (!opId) {
          await sendLongMessage(bot, chatId, "Usage: /diff <opId>");
          return;
        }

        const res = await diffOperation(opId);

        for (const d of res.diffs) {
          const header = `🧩 diff: ${d.file}\n`;
          const body = "```diff\n" + d.diff + "\n```";
          await sendLongMessage(bot, chatId, header + body, {
            parse_mode: "Markdown",
          });
        }
        return;
      }

      if (text.startsWith("/apply ")) {
        const opId = text.split(" ")[1]?.trim();
        if (!opId) {
          await sendLongMessage(bot, chatId, "Usage: /apply <opId>");
          return;
        }
        if (!admins.has(chatId)) {
          await sendLongMessage(
            bot,
            chatId,
            "❌ /apply is restricted to admins.",
          );
          return;
        }
        if (!builderMode) {
          await sendLongMessage(
            bot,
            chatId,
            "❌ /apply requires dev mode. Use /devon or /dev ...",
          );
          return;
        }

        const out = await applyOperation(opId);
        await sendLongMessage(
          bot,
          chatId,
          `✅ Applied: ${out.opId}\nFiles:\n- ${out.files.join("\n- ")}`,
        );
        return;
      }

      if (text.startsWith("/rollback ")) {
        const opId = text.split(" ")[1]?.trim();
        if (!opId) {
          await sendLongMessage(bot, chatId, "Usage: /rollback <opId>");
          return;
        }
        if (!admins.has(chatId)) {
          await sendLongMessage(
            bot,
            chatId,
            "❌ /rollback is restricted to admins.",
          );
          return;
        }
        if (!builderMode) {
          await sendLongMessage(
            bot,
            chatId,
            "❌ /rollback requires dev mode. Use /devon.",
          );
          return;
        }

        const out = await rollbackOperation(opId);
        await sendLongMessage(
          bot,
          chatId,
          `✅ Rolled back: ${out.opId} (${out.status})`,
        );
        return;
      }

      if (text.startsWith("/discard ")) {
        const opId = text.split(" ")[1]?.trim();
        if (!opId) {
          await sendLongMessage(bot, chatId, "Usage: /discard <opId>");
          return;
        }
        if (!admins.has(chatId)) {
          await sendLongMessage(
            bot,
            chatId,
            "❌ /discard is restricted to admins.",
          );
          return;
        }

        const op = await loadOp(opId);
        op.status = "discarded";
        await saveOp(op);
        await appendLog({
          t: new Date().toISOString(),
          type: "discard",
          opId,
          by: chatId,
        });

        await sendLongMessage(bot, chatId, `🗑 Discarded: ${opId}`);
        return;
      }

      // ---------------------------
      // Basic commands
      // ---------------------------

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
            "/dev <text> - route to DEV model + builder mode",
            "/devon - set dev as default (no need to type /dev)",
            "/devoff - disable dev default",
            "/autopilot on|off|status - enable autopilot workflow in dev",
            "",
            "Builder commands (deterministic):",
            "/lastop",
            "/status <opId>",
            "/diff <opId>",
            "/apply <opId>   (admin + /devon)",
            "/rollback <opId> (admin + /devon)",
            "/discard <opId> (admin)",
            "",
            "Normal messages use runtime provider.",
            "Tool requests may ask for approval with buttons.",
          ].join("\n"),
        );
        return;
      }

      if (text === "/id") {
        await sendLongMessage(
          bot,
          chatId,
          `chatId: ${chatId}\nsessionId: ${sessionId}`,
        );
        return;
      }

      if (text === "/reset") {
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

      // ---------------------------
      // Route (/dev => builder mode), supports /devon default
      // ---------------------------

      const rawUserInput = isDevExplicit
        ? text.replace(/^\/dev\s*/i, "")
        : text;
      if (isDevExplicit && !rawUserInput.trim()) {
        await sendLongMessage(bot, chatId, "Usage: /dev <your request>");
        return;
      }

      // Autopilot gating: only in dev + admin
      const autopilotEnabled = Boolean(s.meta.autopilot);
      const autopilotPreamble = autopilotActive
        ? [
            "[AUTOPILOT MODE]",
            "You MUST implement changes via Builder workflow only:",
            "1) stage_file (create or reuse opId)",
            "2) diff_op (show diff summary)",
            "3) apply_patch",
            "4) run_cmd with exact command: npm run build",
            "If build fails: rollback.",
            "Never edit repo directly outside builder tools.",
            "",
          ].join("\n")
        : "";

      const userInput = `[trace:${traceId}]\n${autopilotPreamble}${rawUserInput}`;

      await sendLongMessage(
        bot,
        chatId,
        `🧠 Working… (session ${sessionId}, ${purpose}${autopilotActive ? ", autopilot" : ""}, trace ${traceId})`,
      );

      // Approval function
      const approve = async (call: any): Promise<boolean> => {
        const toolName = (call?.name ?? call?.tool ?? "").toString();

        // Autopilot fast-path: no buttons for builder tools (dev + admin only)
        if (autopilotActive) {
          if (
            toolName === "stage_file" ||
            toolName === "diff_op" ||
            toolName === "apply_patch" ||
            toolName === "rollback" ||
            toolName === "run_cmd" ||
            toolName === "read_file" ||
            toolName === "list_dir"
          ) {
            return true;
          }
        }

        // Always allow safe read tools
        if (toolName === "read_file" || toolName === "list_dir") return true;

        // write_file: only admins; runtime restricts paths (adapter UX-level gating)
        if (toolName === "write_file") {
          if (!admins.has(chatId)) {
            await sendLongMessage(
              bot,
              chatId,
              "❌ write_file is restricted to admins.",
            );
            return false;
          }

          try {
            const a = JSON.parse(call?.argumentsJson ?? "{}");
            const p = String(a?.path ?? "");
            const isSafe = p.startsWith("data/outputs/"); // keep strict here

            if (!builderMode && !isSafe) {
              await sendLongMessage(
                bot,
                chatId,
                `❌ write_file in runtime is restricted to data/outputs/* (got: ${p})`,
              );
              return false;
            }
          } catch {
            await sendLongMessage(
              bot,
              chatId,
              "❌ write_file: invalid arguments.",
            );
            return false;
          }

          return true;
        }

        // Everything else: interactive approval
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

        const messageId = (sent as any)?.message_id;
        if (typeof messageId !== "number") {
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

      console.log("MODE", {
        traceId,
        builderMode,
        devDefault,
        isDevExplicit,
        purpose,
        autopilotActive,
      });
      // HARD normalize (żeby nic innego nie przeszło)
      const res = await runAgentToolLoop(session, {
        purpose,
        input: userInput,
        maxSteps: autopilotActive ? 10 : 3,
        approve,
        traceId,
      } as any);

      await saveSession(session);

      const usageNorm = normalizeUsageAny((res as any).usage);

      await logEvent({
        level: "info",
        event: "telegram_done",
        session: session.id,
        purpose,
        provider: (res as any).provider,
        model: (res as any).model,
        details: { traceId, usage: usageNorm },
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
        `✅ [${(res as any).provider}/${(res as any).model}] (trace ${traceId})\n\n${(res as any).text}${footer}`,
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

      const data = q.data;

      let action: "approve" | "deny" | null = null;
      let key = "";

      if (data.startsWith("approve:")) {
        action = "approve";
        key = data.slice("approve:".length);
      } else if (data.startsWith("deny:")) {
        action = "deny";
        key = data.slice("deny:".length);
      } else {
        return;
      }

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

      await bot.editMessageText(
        `🔧 TOOL REQUEST (${ok ? "APPROVED ✅" : "DENIED ❌"})\n\`\`\`\n${shortJson(p.call)}\n\`\`\``,
        { chat_id: p.chatId, message_id: p.messageId, parse_mode: "Markdown" },
      );

      p.resolve(ok);
    } catch {
      try {
        await bot.answerCallbackQuery((q as any).id, { text: "Error." });
      } catch {}
    }
  });

  await logEvent({ level: "info", event: "telegram_started" });
  console.log("Telegram adapter started (polling).");
}
