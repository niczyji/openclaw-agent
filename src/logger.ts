import { promises as fs } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEvent = {
  ts: string;
  level: LogLevel;
  event: string;

  session?: string;
  purpose?: string;
  provider?: string;
  model?: string;

  ms?: number;

  errorClass?: string;
  message?: string;
  details?: any;
};

const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

function nowISO() {
  return new Date().toISOString();
}

export function classifyError(e: any): string {
  const msg = String(e?.message ?? e ?? "");

  // Common infra classes
  if (msg.includes("Missing required env variable")) return "config_missing_env";
  if (msg.includes("ANTHROPIC_API_KEY not set")) return "config_missing_key";
  if (e?.code === "ENOTFOUND" || e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT")
    return "network";
  if (e?.status === 401 || msg.includes("401")) return "auth";
  if (e?.status === 404 || msg.includes("not_found_error") || msg.includes("model:"))
    return "model_not_found";

  return "unknown";
}

export async function logEvent(ev: Omit<LogEvent, "ts">) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const line = JSON.stringify({ ts: nowISO(), ...ev }) + "\n";
  await fs.appendFile(LOG_FILE, line, "utf8");
}

export async function withTiming<T>(
  meta: Omit<LogEvent, "ts" | "level" | "event" | "ms">,
  fn: () => Promise<T>,
) {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    await logEvent({ level: "info", event: "ok", ms, ...meta });
    return result;
  } catch (e: any) {
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
