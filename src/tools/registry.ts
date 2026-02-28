// tools/registry.ts
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import type { Purpose } from "../core/types.js";
import { assertAllowedPath, assertAllowedCommand } from "./policy.ts";

export type ToolCtx = { purpose: Purpose };

type ModelToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

// Safety caps (adjust as needed)
const MAX_READ_CHARS = 50_000;
const MAX_LIST_ENTRIES = 300;
const MAX_CMD_OUT = 8_000;
const RUN_CMD_TIMEOUT_MS = 10_000;

// -------------------------
// Helpers
// -------------------------
function ok(tool: string, result: any) {
  return { ok: true, tool, result };
}
function fail(tool: string, error: string, details?: any) {
  return { ok: false, tool, error, details };
}

function asString(x: any): string {
  if (typeof x === "string") return x;
  return String(x ?? "");
}

function truncate(s: string, max: number) {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

async function atomicWrite(fullPath: string, content: string) {
  const dir = path.dirname(fullPath);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(
    dir,
    `.tmp-${path.basename(fullPath)}-${crypto.randomUUID()}`,
  );

  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, fullPath);
}

// -------------------------
// Tool implementations
// -------------------------
async function toolReadFile(args: any, ctx: ToolCtx) {
  const userPath = asString(args?.path);
  if (!userPath) return fail("read_file", "Missing required field: path");

  const full = await assertAllowedPath(userPath, {
    kind: "read",
    purpose: ctx.purpose,
  });

  const raw = await fs.readFile(full, "utf8");
  const { text, truncated } = truncate(raw, MAX_READ_CHARS);

  return ok("read_file", {
    path: userPath,
    bytes: Buffer.byteLength(raw, "utf8"),
    truncated,
    content: text,
  });
}

async function toolListDir(args: any, ctx: ToolCtx) {
  const userPath = asString(args?.path || ".");
  const full = await assertAllowedPath(userPath, {
    kind: "read",
    purpose: ctx.purpose,
  });

  const entries = await fs.readdir(full, { withFileTypes: true });

  const mapped = entries.slice(0, MAX_LIST_ENTRIES).map((e) => ({
    name: e.name,
    type: e.isDirectory()
      ? "dir"
      : e.isFile()
        ? "file"
        : e.isSymbolicLink()
          ? "symlink"
          : "other",
  }));

  return ok("list_dir", {
    path: userPath,
    capped: entries.length > MAX_LIST_ENTRIES,
    entries: mapped,
  });
}

async function toolWriteFile(args: any, ctx: ToolCtx) {
  const userPath = asString(args?.path);
  const content = asString(args?.content);
  const overwrite = Boolean(args?.overwrite);

  if (!userPath) return fail("write_file", "Missing required field: path");
  if (args?.content === undefined)
    return fail("write_file", "Missing required field: content");

  const full = await assertAllowedPath(userPath, {
    kind: "write",
    purpose: ctx.purpose,
  });

  // overwrite gating
  try {
    await fs.stat(full);
    if (!overwrite) {
      return fail(
        "write_file",
        "File exists. Set overwrite=true to overwrite.",
      );
    }
  } catch {
    // file does not exist -> ok
  }

  await atomicWrite(full, content);

  return ok("write_file", {
    path: userPath,
    bytes: Buffer.byteLength(content, "utf8"),
    overwritten: overwrite,
  });
}

async function toolCalculator(args: any) {
  const expr = asString(args?.expression);
  if (!expr) return fail("calculator", "Missing required field: expression");

  // Debug-safe: only allow simple math chars
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
    return fail(
      "calculator",
      "Bad expression (allowed: digits, + - * / ( ) . whitespace)",
    );
  }

  try {
    // Still eval-ish; acceptable as infra test tool.
    const value = Function(`"use strict"; return (${expr});`)();
    return ok("calculator", { expression: expr, value });
  } catch (e: any) {
    return fail("calculator", `Eval failed: ${String(e?.message ?? e)}`);
  }
}

async function toolRunCmd(args: any) {
  const command = asString(args?.command);
  if (!command) return fail("run_cmd", "Missing required field: command");

  const cmd = assertAllowedCommand(command); // exact-match allowlist

  const [bin, ...binArgs] = cmd.split(" ");

  return await new Promise((resolve) => {
    const child = spawn(bin, binArgs, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, RUN_CMD_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    child.on("close", (code) => {
      clearTimeout(killTimer);

      const outT = truncate(stdout, MAX_CMD_OUT);
      const errT = truncate(stderr, MAX_CMD_OUT);

      resolve(
        ok("run_cmd", {
          command: cmd,
          code,
          ok: code === 0,
          stdout: outT.text,
          stdoutTruncated: outT.truncated,
          stderr: errT.text,
          stderrTruncated: errT.truncated,
        }),
      );
    });
  });
}

// tools/registry.ts (ADD THIS)
export type ManualToolCall =
  | { tool: "read_file"; path: string }
  | { tool: "list_dir"; path: string }
  | { tool: "write_file"; path: string; content: string; overwrite?: boolean }
  | { tool: "calculator"; expression: string }
  | { tool: "run_cmd"; command: string };

export type ManualToolResult =
  | { ok: true; tool: string; result: any }
  | { ok: false; tool: string; error: string; details?: any };

/**
 * Legacy/manual tool runner for CLI (returns object, not JSON string).
 * Default purpose: runtime.
 */
export async function runTool(
  call: ManualToolCall,
  ctx: ToolCtx = { purpose: "runtime" as Purpose },
): Promise<ManualToolResult> {
  try {
    switch (call.tool) {
      case "read_file":
        return await toolReadFile({ path: call.path }, ctx);
      case "list_dir":
        return await toolListDir({ path: call.path }, ctx);
      case "write_file":
        return await toolWriteFile(
          {
            path: call.path,
            content: call.content,
            overwrite: call.overwrite ?? false,
          },
          ctx,
        );
      case "calculator":
        return await toolCalculator({ expression: (call as any).expression });
      case "run_cmd":
        return await toolRunCmd({ command: (call as any).command });
      default:
        return {
          ok: false,
          tool: (call as any)?.tool ?? "unknown",
          error: "Unknown tool",
        };
    }
  } catch (e: any) {
    return {
      ok: false,
      tool: (call as any)?.tool ?? "unknown",
      error: String(e?.message ?? e),
      details: e?.stack,
    };
  }
}

// -------------------------
// Public entrypoint
// -------------------------
export async function runToolFromModelCall(
  call: ModelToolCall,
  ctx?: ToolCtx,
): Promise<string> {
  const safeCtx: ToolCtx = ctx ?? ({ purpose: "runtime" } as any);

  const tool = call?.name || "unknown";
  let args: any = {};
  try {
    args = call?.argumentsJson ? JSON.parse(call.argumentsJson) : {};
  } catch (e: any) {
    return JSON.stringify(
      fail(tool, `Invalid argumentsJson: ${String(e?.message ?? e)}`),
      null,
      2,
    );
  }

  try {
    let out: any;
    switch (tool) {
      case "read_file":
        out = await toolReadFile(args, safeCtx);
        break;
      case "list_dir":
        out = await toolListDir(args, safeCtx);
        break;
      case "write_file":
        out = await toolWriteFile(args, safeCtx);
        break;
      case "calculator":
        out = await toolCalculator(args);
        break;
      case "run_cmd":
        out = await toolRunCmd(args);
        break;
      default:
        out = fail(tool, "Unknown tool");
    }
    return JSON.stringify(out, null, 2);
  } catch (e: any) {
    return JSON.stringify(
      fail(tool, String(e?.message ?? e), e?.stack),
      null,
      2,
    );
  }
}
