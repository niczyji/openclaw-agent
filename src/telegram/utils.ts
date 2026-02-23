// src/telegram-main.ts
import "dotenv/config";

// src/adapters/telegram.ts
import TelegramBot from "node-telegram-bot-api";
import { sendLongMessage } from "../telegram/utils.js";

// src/memory/store.ts
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
var SESS_DIR = path.resolve("data/sessions");
function nowISO() {
  return /* @__PURE__ */ new Date().toISOString();
}
function newSessionId() {
  return crypto.randomUUID();
}
function sessionPath(id) {
  return path.join(SESS_DIR, `${id}.json`);
}
async function loadSession(id) {
  try {
    const raw = await fs.readFile(sessionPath(id), "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}
async function saveSession(s) {
  await fs.mkdir(SESS_DIR, { recursive: true });
  s.updatedAt = nowISO();
  await fs.writeFile(sessionPath(s.id), JSON.stringify(s, null, 2), "utf8");
}
async function getOrCreateSession(id) {
  if (id) {
    const existing = await loadSession(id);
    if (existing) return existing;
    return {
      id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      messages: [],
    };
  }
  const newId = newSessionId();
  return {
    id: newId,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    messages: [],
  };
}

// src/config.ts
import "dotenv/config";
function env(name) {
  return process.env[name];
}
function requireEnv(name) {
  const v = env(name);
  if (!v) throw new Error(`Missing required env variable: ${name}`);
  return v;
}
var config = {
  providers: {
    default: "grok",
    dev: "anthropic",
  },
  grok: {
    apiKey: requireEnv("GROK_API_KEY"),
    model: env("GROK_MODEL") ?? "grok-3-mini",
    baseURL: env("GROK_BASE_URL") ?? "https://api.x.ai/v1",
  },
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY") ?? null,
    model: env("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-latest",
  },
};

// src/providers/grok.ts
import OpenAI from "openai";
var client = new OpenAI({
  apiKey: config.grok.apiKey,
  baseURL: config.grok.baseURL,
});
async function grokChat(req) {
  const res = await client.chat.completions.create({
    model: config.grok.model,
    messages: req.messages,
    temperature: req.temperature,
  });
  const text = res.choices[0]?.message?.content ?? "(no response)";
  const usage = res.usage;
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens;
  const totalTokens =
    usage?.total_tokens ??
    (typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : void 0);
  return {
    text,
    provider: "grok",
    model: config.grok.model,
    usage: { inputTokens, outputTokens, totalTokens },
  };
}

// src/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
var client2 = new Anthropic({
  apiKey: config.anthropic.apiKey ?? "",
});
function toAnthropicMessages(messages) {
  const systemParts = [];
  const msgs = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else if (m.role === "user") msgs.push({ role: "user", content: m.content });
    else msgs.push({ role: "assistant", content: m.content });
  }
  const system = systemParts.length ? systemParts.join("\n\n") : void 0;
  return { system, msgs };
}
async function anthropicChat(req) {
  if (!config.anthropic.apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set. Set it in .env to enable Anthropic.",
    );
  }
  const { system, msgs } = toAnthropicMessages(req.messages);
  const res = await client2.messages.create({
    model: config.anthropic.model,
    max_tokens: 600,
    temperature: req.temperature ?? 0.2,
    system,
    messages: msgs.length ? msgs : [{ role: "user", content: "Hello" }],
  });
  const inputTokens = res.usage?.input_tokens;
  const outputTokens = res.usage?.output_tokens;
  const totalTokens =
    typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : void 0;
  const text =
    res.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("") || "(no response)";
  return {
    text,
    provider: "anthropic",
    model: config.anthropic.model,
    usage: { inputTokens, outputTokens, totalTokens },
  };
}

// src/core/router.ts
function resolveProvider(purpose) {
  if (purpose === "dev") return config.providers.dev;
  return config.providers.default;
}
async function chat(req) {
  const provider = resolveProvider(req.purpose);
  if (provider === "grok") return grokChat(req);
  if (provider === "anthropic") return anthropicChat(req);
  throw new Error(`Unknown provider resolved: ${provider}`);
}

// src/tools/registry.ts
import { promises as fs2 } from "fs";
import path3 from "path";

// src/tools/policy.ts
import path2 from "path";
var PROJECT_ROOT = process.cwd();
var ALLOWED_PREFIXES = [
  "src",
  "data",
  "logs",
  "notes",
  "README.md",
  "package.json",
].map((p) => path2.resolve(PROJECT_ROOT, p));
var DENY_SEGMENTS = /* @__PURE__ */ new Set([".git", "node_modules"]);
var DENY_FILES = /* @__PURE__ */ new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
]);
function hasDeniedSegment(fullPath) {
  const rel = path2.relative(PROJECT_ROOT, fullPath);
  const parts = rel.split(path2.sep);
  return parts.some((p) => DENY_SEGMENTS.has(p));
}
function isDeniedFile(fullPath) {
  const base = path2.basename(fullPath);
  return DENY_FILES.has(base);
}
function assertAllowedPath(userPath) {
  const full = path2.resolve(PROJECT_ROOT, userPath);
  if (hasDeniedSegment(full))
    throw new Error(`Path denied by policy (segment): ${userPath}`);
  if (isDeniedFile(full))
    throw new Error(`Path denied by policy (file): ${userPath}`);
  const allowed = ALLOWED_PREFIXES.some(
    (prefix) => full === prefix || full.startsWith(prefix + path2.sep),
  );
  if (!allowed) throw new Error(`Path not allowed by policy: ${userPath}`);
  return full;
}

// src/tools/registry.ts
var MAX_READ_BYTES = 2e5;
var MAX_DIR_ENTRIES = 200;
function redactSecrets(text) {
  const patterns = [
    [/(API_KEY\s*=\s*)(.+)/gi, "$1***REDACTED***"],
    [/(GROK_API_KEY\s*=\s*)(.+)/gi, "$1***REDACTED***"],
    [/(OPENAI_API_KEY\s*=\s*)(.+)/gi, "$1***REDACTED***"],
    [/(ANTHROPIC_API_KEY\s*=\s*)(.+)/gi, "$1***REDACTED***"],
    [/(TOKEN\s*=\s*)(.+)/gi, "$1***REDACTED***"],
    [/(SECRET\s*=\s*)(.+)/gi, "$1***REDACTED***"],
    [/(PASSWORD\s*=\s*)(.+)/gi, "$1***REDACTED***"],
  ];
  let out = text;
  for (const [re, repl] of patterns) out = out.replace(re, repl);
  return out;
}
async function runTool(call) {
  try {
    if (call.tool === "read_file") {
      const full = assertAllowedPath(call.path);
      const st = await fs2.stat(full);
      if (st.size > MAX_READ_BYTES) {
        return {
          ok: false,
          tool: call.tool,
          error: `File too large (${st.size} bytes). Max is ${MAX_READ_BYTES}.`,
        };
      }
      let content = await fs2.readFile(full, "utf8");
      content = redactSecrets(content);
      const MAX_CHARS = 4e3;
      let truncated = false;
      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS) + "\n\n...TRUNCATED...\n";
        truncated = true;
      }
      return {
        ok: true,
        tool: call.tool,
        result: { path: call.path, bytes: st.size, truncated, content },
      };
    }
    if (call.tool === "list_dir") {
      const full = assertAllowedPath(call.path);
      const entries = await fs2.readdir(full, { withFileTypes: true });
      const sliced = entries.slice(0, MAX_DIR_ENTRIES);
      return {
        ok: true,
        tool: call.tool,
        result: {
          path: call.path,
          totalEntries: entries.length,
          returnedEntries: sliced.length,
          entries: sliced.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "dir" : "file",
          })),
        },
      };
    }
    if (call.tool === "write_file") {
      const full = assertAllowedPath(call.path);
      const outRoot = assertAllowedPath("data/outputs");
      if (!full.startsWith(outRoot + path3.sep) && full !== outRoot) {
        throw new Error(
          `write_file restricted to data/outputs/* (got: ${call.path})`,
        );
      }
      await fs2.mkdir(path3.dirname(full), { recursive: true });
      if (!call.overwrite) {
        try {
          await fs2.access(full);
          throw new Error(`File exists (set --overwrite): ${call.path}`);
        } catch (e) {
          if (e?.code !== "ENOENT") throw e;
        }
      }
      await fs2.writeFile(full, call.content, "utf8");
      return {
        ok: true,
        tool: call.tool,
        result: { path: call.path, bytes: call.content.length },
      };
    }
    return { ok: false, tool: call.tool, error: "Unknown tool" };
  } catch (e) {
    return { ok: false, tool: call.tool, error: String(e?.message ?? e) };
  }
}

// src/logger.ts
import { promises as fs3 } from "fs";
import path4 from "path";
var LOG_DIR = path4.resolve("logs");
var LOG_FILE = path4.join(LOG_DIR, "app.log");
function nowISO2() {
  return /* @__PURE__ */ new Date().toISOString();
}
function classifyError(e) {
  const msg = String(e?.message ?? e ?? "");
  if (msg.includes("Missing required env variable"))
    return "config_missing_env";
  if (msg.includes("ANTHROPIC_API_KEY not set")) return "config_missing_key";
  if (
    e?.code === "ENOTFOUND" ||
    e?.code === "ECONNRESET" ||
    e?.code === "ETIMEDOUT"
  )
    return "network";
  if (e?.status === 401 || msg.includes("401")) return "auth";
  if (
    e?.status === 404 ||
    msg.includes("not_found_error") ||
    msg.includes("model:")
  )
    return "model_not_found";
  return "unknown";
}
async function logEvent(ev) {
  await fs3.mkdir(LOG_DIR, { recursive: true });
  const line = JSON.stringify({ ts: nowISO2(), ...ev }) + "\n";
  await fs3.appendFile(LOG_FILE, line, "utf8");
}
async function withTiming(meta, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    await logEvent({ level: "info", event: "ok", ms, ...meta });
    return result;
  } catch (e) {
    const ms = Date.now() - start;
    await logEvent({
      level: "error",
      event: "error",
      ms,
      errorClass: classifyError(e),
      message: String(e?.message ?? e),
      details: e?.response ?? e,
      ...meta,
    });
    throw e;
  }
}

// src/core/toolloop.ts
function extractToolCall(text) {
  const m = text.match(/```toolcall\s*([\s\S]*?)\s*```/i);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (!obj?.tool) return null;
    return obj;
  } catch {
    return null;
  }
}
function toolSystemPrompt(base) {
  const rules = [
    base ?? "You are a helpful assistant.",
    "",
    "TOOL RULES:",
    "- If you need filesystem info, you MAY request exactly one tool call.",
    "- When requesting a tool, output ONLY a single code block like:",
    "```toolcall",
    '{ "tool": "list_dir", "path": "src" }',
    "```",
    "- Do NOT add any other text around the toolcall.",
    "- After you receive the tool result, respond normally with the final answer.",
    "- Available tools: read_file, list_dir, write_file (write_file only allowed in data/outputs/*).",
  ];
  return rules.join("\n");
}
async function runAgentToolLoop(session, opts) {
  const keep = opts.keepLastN ?? 20;
  const maxSteps = opts.maxSteps ?? 3;
  const history = session.messages.slice(-keep);
  const messages = [
    { role: "system", content: toolSystemPrompt(opts.system) },
    ...history,
    { role: "user", content: opts.input },
  ];
  const temp = opts.purpose === "dev" ? 0.5 : 0.2;
  let finalText = "";
  let lastProvider = "";
  let writesUsed = 0;
  const maxWrites = 1;
  let lastModel = "";
  for (let step = 1; step <= maxSteps; step++) {
    const res2 = await withTiming(
      {
        event: "llm_step",
        session: session.id,
        purpose: opts.purpose,
        details: { step },
      },
      async () => chat({ purpose: opts.purpose, messages, temperature: temp }),
    );
    lastProvider = res2.provider;
    lastModel = res2.model;
    const call = extractToolCall(res2.text);
    if (!call) {
      finalText = res2.text;
      session.messages.push({ role: "user", content: opts.input });
      session.messages.push({ role: "assistant", content: finalText });
      await logEvent({
        level: "info",
        event: "toolloop_done",
        session: session.id,
        purpose: opts.purpose,
        provider: lastProvider,
        model: lastModel,
        details: { step },
      });
      return {
        text: finalText,
        provider: res2.provider,
        model: res2.model,
        usage: res2.usage,
      };
    }
    if (call.tool === "write_file") {
      if (writesUsed >= maxWrites) {
        messages.push({
          role: "assistant",
          content:
            "Tool request rejected: write_file budget exceeded for this run.",
        });
        messages.push({
          role: "user",
          content:
            "You already used a write_file. Continue without any more writes and finish the task.",
        });
        await logEvent({
          level: "warn",
          event: "write_budget_exceeded",
          session: session.id,
          purpose: opts.purpose,
          details: { step, maxWrites },
        });
        continue;
      }
    }
    await logEvent({
      level: "info",
      event: "tool_suggested",
      session: session.id,
      purpose: opts.purpose,
      provider: lastProvider,
      model: lastModel,
      details: { step, call },
    });
    const approved = await opts.approve(call);
    await logEvent({
      level: approved ? "info" : "warn",
      event: approved ? "tool_approved" : "tool_denied",
      session: session.id,
      purpose: opts.purpose,
      details: { step, call },
    });
    if (!approved) {
      messages.push({
        role: "assistant",
        content: "Tool request denied by user.",
      });
      messages.push({
        role: "user",
        content:
          "Tool request denied. Continue without tools and answer with best effort.",
      });
      continue;
    }
    const toolRes = await withTiming(
      {
        event: "tool_exec",
        session: session.id,
        purpose: opts.purpose,
        details: { step, call },
      },
      async () => runTool(call),
    );
    await logEvent({
      level: toolRes.ok ? "info" : "error",
      event: "tool_result",
      session: session.id,
      purpose: opts.purpose,
      details: { step, toolRes },
    });
    if (call.tool === "write_file" && toolRes.ok) {
      writesUsed++;
    }
    messages.push({
      role: "assistant",
      content: `Tool call executed: ${JSON.stringify(call)}`,
    });
    messages.push({
      role: "user",
      content: `TOOL_RESULT:
${JSON.stringify(toolRes, null, 2)}`,
    });
  }
  const res = await chat({
    purpose: opts.purpose,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Max tool steps reached. Provide the best final answer now without further tools.",
      },
    ],
    temperature: temp,
  });
  finalText = res.text;
  session.messages.push({ role: "user", content: opts.input });
  session.messages.push({ role: "assistant", content: finalText });
  return {
    text: finalText,
    provider: res.provider,
    model: res.model,
    usage: res.usage,
  };
}

// src/memory/sessions.ts
import { promises as fs4 } from "fs";
import path5 from "path";
var SESS_DIR2 = path5.resolve("data/sessions");
function sessionPath2(id) {
  return path5.join(SESS_DIR2, `${id}.json`);
}
async function deleteSession(id) {
  await fs4.unlink(sessionPath2(id));
}

// src/adapters/telegram.ts
function parseIds(envName) {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return new Set(ids);
}
function rateLimitSeconds() {
  const n = Number(process.env.TELEGRAM_RATE_LIMIT_SECONDS ?? "0");
  return Number.isFinite(n) ? n : 0;
}
function showUsage() {
  return (process.env.TELEGRAM_SHOW_USAGE ?? "").trim() === "1";
}
function numEnv(name) {
  const v = (process.env[name] ?? "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function estimateCostUsd(provider, usage) {
  if (!usage) return null;
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  let inRate = null;
  let outRate = null;
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
function shortJson(x) {
  const s = JSON.stringify(x, null, 2);
  return s.length > 3500 ? s.slice(0, 3500) + "\n...TRUNCATED..." : s;
}
async function startTelegramAdapter(opts) {
  const allowed = parseIds("TELEGRAM_ALLOWED_CHAT_IDS");
  const admins =
    parseIds("TELEGRAM_ADMIN_CHAT_IDS") ?? /* @__PURE__ */ new Set();
  const cooldownSec = rateLimitSeconds();
  const showUsageFlag = showUsage();
  const lastSeen = /* @__PURE__ */ new Map();
  const bot = new TelegramBot(opts.token, { polling: true });
  const pending = /* @__PURE__ */ new Map();
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();
    try {
      if (allowed && !allowed.has(chatId)) {
        await sendLongMessage(bot, chatId, "Not allowed.");
        return;
      }
      if (!text) return;
      if (
        cooldownSec > 0 &&
        !text.startsWith("/help") &&
        !text.startsWith("/start") &&
        !text.startsWith("/id") &&
        !text.startsWith("/reset")
      ) {
        const now = Date.now();
        const last = lastSeen.get(chatId) ?? 0;
        if (now - last < cooldownSec * 1e3) {
          await sendLongMessage(
            bot,
            chatId,
            `\u23F3 Cooldown: please wait ${cooldownSec}s between requests.`,
          );
          return;
        }
        lastSeen.set(chatId, now);
      }
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
          `chatId: ${chatId}
sessionId: tg-${chatId}`,
        );
        return;
      }
      if (text === "/reset") {
        const sessionId2 = `tg-${chatId}`;
        try {
          await deleteSession(sessionId2);
          await sendLongMessage(
            bot,
            chatId,
            `\u{1F9F9} Session reset: ${sessionId2}`,
          );
        } catch {
          await sendLongMessage(
            bot,
            chatId,
            `\u{1F9F9} No session file to delete for: ${sessionId2}`,
          );
        }
        return;
      }
      const isDev = text.startsWith("/dev ");
      const userInput = isDev ? text.replace(/^\/dev\s+/, "") : text;
      const purpose = isDev ? "dev" : "default";
      const sessionId = `tg-${chatId}`;
      const session = await getOrCreateSession(sessionId);
      await sendLongMessage(
        bot,
        chatId,
        `\u{1F9E0} Working\u2026 (session ${sessionId}, ${purpose})`,
      );
      const approve = async (call) => {
        if (call.tool === "write_file" && !admins.has(chatId)) {
          await sendLongMessage(
            bot,
            chatId,
            "\u274C write_file is restricted to admins.",
          );
          return false;
        }
        const key = `${chatId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
        const sent = await sendLongMessage(
          bot,
          chatId,
          `\u{1F527} TOOL REQUEST
\`\`\`
${shortJson(call)}
\`\`\`
Approve?`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "\u2705 Approve", callback_data: `approve:${key}` },
                  { text: "\u274C Deny", callback_data: `deny:${key}` },
                ],
              ],
            },
          },
        );
        return await new Promise((resolve) => {
          pending.set(key, {
            resolve,
            chatId,
            messageId: sent.message_id,
            call,
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
      await logEvent({
        level: "info",
        event: "telegram_done",
        session: session.id,
        purpose,
        provider: res.provider,
        model: res.model,
        details: { usage: res.usage ?? null },
      });
      let footer = "";
      if (showUsageFlag && res.usage?.totalTokens != null) {
        const cost = estimateCostUsd(res.provider, res.usage);
        const costStr = cost == null ? "" : ` \u2022 est=$${cost.toFixed(6)}`;
        footer = `

\u{1F4CA} tokens: in=${res.usage.inputTokens ?? "?"} out=${res.usage.outputTokens ?? "?"} total=${res.usage.totalTokens}${costStr}`;
      }
      await sendLongMessage(
        bot,
        chatId,
        `\u2705 [${res.provider}/${res.model}]

${res.text}${footer}`,
      );
    } catch (e) {
      await logEvent({
        level: "error",
        event: "telegram_error",
        errorClass: classifyError(e),
        message: String(e?.message ?? e),
      });
      await sendLongMessage(
        bot,
        chatId,
        `\u2757 Error: ${String(e?.message ?? e)}`,
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
      const ok = action === "approve";
      pending.delete(key);
      await bot.answerCallbackQuery(q.id, { text: ok ? "Approved" : "Denied" });
      await bot.editMessageText(
        `\u{1F527} TOOL REQUEST (${ok ? "APPROVED \u2705" : "DENIED \u274C"})
\`\`\`
${shortJson(p.call)}
\`\`\``,
        { chat_id: p.chatId, message_id: p.messageId, parse_mode: "Markdown" },
      );
      p.resolve(ok);
    } catch {
      try {
        await bot.answerCallbackQuery(q.id, { text: "Error." });
      } catch {}
    }
  });
  await logEvent({ level: "info", event: "telegram_started" });
  console.log("Telegram adapter started (polling).");
}

// src/telegram-main.ts
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  await startTelegramAdapter({ token });
}
main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
//# sourceMappingURL=telegram-main.js.map
