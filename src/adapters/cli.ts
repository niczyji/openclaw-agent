// src/adapters/cli.ts
import { promises as fs } from "node:fs";
import readline from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";

import { getOrCreateSession, saveSession } from "../memory/store";
import { runAgent } from "../core/agent";
import type {
  Purpose,
  ProviderId,
  LlmMessage,
  ToolCall,
  LlmRequest,
} from "../core/types";

import { runTool } from "../tools/registry";
import type { ToolName } from "../tools/types";

import { runToolLoop } from "../core/toolloop";
import { ALL_TOOLS } from "../tools/definitions";

import {
  listSessions,
  readSessionFile,
  deleteSession,
  exportSessionMarkdown,
  pruneSessionsOlderThan,
} from "../memory/sessions";

import { logEvent, withTiming, classifyError } from "../logger";

type Cmd = "default" | "run";

type Args = {
  cmd: Cmd;

  dev: boolean;
  heartbeat: boolean;
  session?: string;
  system?: string;

  json: boolean;

  // provider controls (for run/toolloop)
  provider?: ProviderId;
  model?: string;

  maxSteps?: number;
  maxToolCalls?: number;
  maxOutputTokens?: number;

  // manual tools
  tool?: ToolName;
  path?: string;
  content?: string;
  overwrite?: boolean;

  // session commands
  listSessions: boolean;
  showSession?: string;
  clearSession?: string;
  exportSession?: string;
  out?: string;
  pruneDays?: number;

  // toolloop (interactive)
  toolloop: boolean;
  yes: boolean;

  // free text input
  input: string;
};

function parseArgs(argv: string[]): Args {
  let cmd: Cmd = "default";

  let dev = false;
  let heartbeat = false;
  let session: string | undefined;
  let system: string | undefined;

  let json = false;

  let provider: ProviderId | undefined;
  let model: string | undefined;
  let maxSteps: number | undefined;
  let maxToolCalls: number | undefined;
  let maxOutputTokens: number | undefined;

  let tool: ToolName | undefined;
  let toolPath: string | undefined;
  let content: string | undefined;
  let overwrite = false;

  let listSessionsFlag = false;
  let showSession: string | undefined;
  let clearSession: string | undefined;
  let exportSession: string | undefined;
  let out: string | undefined;
  let pruneDays: number | undefined;

  let toolloop = false;
  let yes = false;

  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // command
    if (
      !a.startsWith("-") &&
      a === "run" &&
      cmd === "default" &&
      rest.length === 0
    ) {
      cmd = "run";
      continue;
    }

    if (a === "--dev") dev = true;
    else if (a === "--heartbeat") heartbeat = true;
    else if (a === "--session") session = argv[++i];
    else if (a === "--system") system = argv[++i];
    else if (a === "--json") json = true;
    else if (a === "--provider") provider = argv[++i] as ProviderId;
    else if (a === "--model") model = argv[++i];
    else if (a === "--maxSteps") maxSteps = Number(argv[++i]);
    else if (a === "--maxToolCalls") maxToolCalls = Number(argv[++i]);
    else if (a === "--maxOutputTokens") maxOutputTokens = Number(argv[++i]);
    else if (a === "--tool") tool = argv[++i] as ToolName;
    else if (a === "--path") toolPath = argv[++i];
    else if (a === "--content") content = argv[++i];
    else if (a === "--overwrite") overwrite = true;
    else if (a === "--list-sessions") listSessionsFlag = true;
    else if (a === "--show-session") showSession = argv[++i];
    else if (a === "--clear-session") clearSession = argv[++i];
    else if (a === "--export-session") exportSession = argv[++i];
    else if (a === "--out") out = argv[++i];
    else if (a === "--prune-days") pruneDays = Number(argv[++i]);
    else if (a === "--toolloop") toolloop = true;
    else if (a === "--yes") yes = true;
    else rest.push(a);
  }

  const input = rest.join(" ").trim();

  return {
    cmd,
    dev,
    heartbeat,
    session,
    system,

    json,

    provider,
    model,
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : undefined,
    maxToolCalls: Number.isFinite(maxToolCalls) ? maxToolCalls : undefined,
    maxOutputTokens: Number.isFinite(maxOutputTokens)
      ? maxOutputTokens
      : undefined,

    tool,
    path: toolPath,
    content,
    overwrite,

    listSessions: listSessionsFlag,
    showSession,
    clearSession,
    exportSession,
    out,
    pruneDays: Number.isFinite(pruneDays) ? pruneDays : undefined,

    toolloop,
    yes,

    input,
  };
}

function printHelp() {
  console.log(
    `
Usage (human):
  npx tsx src/main.ts "Hello world"
  npx tsx src/main.ts --dev "Review code..."
  npx tsx src/main.ts --heartbeat
  npx tsx src/main.ts --session my-session "Continue..."

OpenClaw runner (machine-friendly):
  npx tsx src/main.ts run --json --provider anthropic --model claude-sonnet-4-6 --maxSteps 6 --maxToolCalls 12 --maxOutputTokens 800 "Goal..."

Manual tools:
  npx tsx src/main.ts --tool list_dir  --path src
  npx tsx src/main.ts --tool read_file --path src/main.ts
  npx tsx src/main.ts --tool write_file --path data/outputs/x.txt --content "hi" [--overwrite]

Session tools:
  npx tsx src/main.ts --list-sessions
  npx tsx src/main.ts --show-session <id>
  npx tsx src/main.ts --clear-session <id>
  npx tsx src/main.ts --export-session <id> --out session.md
  npx tsx src/main.ts --prune-days 30

Toolloop (interactive confirm):
  npx tsx src/main.ts --toolloop --provider anthropic --model claude-sonnet-4-6 "List src and explain components"
  npx tsx src/main.ts --toolloop --yes "auto-approve safe tools only (read_file/list_dir); write_file always asks"
`.trim(),
  );
}

async function handleSessionCommands(args: Args): Promise<boolean> {
  if (args.listSessions) {
    const infos = await listSessions();
    if (!infos.length) {
      console.log("No sessions found.");
      return true;
    }
    for (const s of infos) {
      console.log(
        `${s.id}  msgs=${s.messageCount ?? "?"}  updated=${s.updatedAt ?? "?"}  size=${s.size}`,
      );
    }
    return true;
  }

  if (args.showSession) {
    const s = await readSessionFile(args.showSession);
    console.log(`Session: ${s.id}`);
    console.log(`Created: ${s.createdAt}`);
    console.log(`Updated: ${s.updatedAt}`);
    console.log(`Messages: ${s.messages.length}\n`);
    const last = s.messages.slice(-10);
    for (const m of last) {
      console.log(`[${m.role}] ${m.content}\n`);
    }
    return true;
  }

  if (args.clearSession) {
    await deleteSession(args.clearSession);
    console.log(`Deleted session: ${args.clearSession}`);
    return true;
  }

  if (args.exportSession) {
    const md = await exportSessionMarkdown(args.exportSession);
    const target = args.out ?? `session-${args.exportSession}.md`;
    await fs.writeFile(target, md, "utf8");
    console.log(`Exported to: ${target}`);
    return true;
  }

  if (typeof args.pruneDays === "number" && !Number.isNaN(args.pruneDays)) {
    const removed = await pruneSessionsOlderThan(args.pruneDays);
    console.log(`Pruned ${removed.length} session(s): ${removed.join(", ")}`);
    return true;
  }

  return false;
}

function toPurpose(args: Args): Purpose {
  return args.heartbeat ? "heartbeat" : args.dev ? "dev" : "default";
}

function jsonOut(obj: unknown) {
  processStdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function isSafeToolName(name: string): boolean {
  return name === "read_file" || name === "list_dir";
}

// Helper: convert session messages (stored shape) to LlmMessage
function toLlmMessagesFromSession(session: {
  messages: Array<{ role: string; content: string }>;
}): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of session.messages) {
    if (m.role === "system") out.push({ role: "system", content: m.content });
    else if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant")
      out.push({ role: "assistant", content: m.content });
    else if (m.role === "tool") {
      // If your session store persists tool fields, wire them here.
      // Fallback: keep as assistant text.
      out.push({ role: "assistant", content: m.content });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

export async function main(argv: string[]) {
  const args = parseArgs(argv);

  // 1) Manual tool call (no session needed)
  if (args.tool) {
    if (!args.path) {
      console.error("Missing --path for tool call.");
      process.exit(1);
    }

    const call =
      args.tool === "read_file"
        ? { tool: "read_file" as const, path: args.path }
        : args.tool === "list_dir"
          ? { tool: "list_dir" as const, path: args.path }
          : args.tool === "write_file"
            ? {
                tool: "write_file" as const,
                path: args.path,
                content: args.content ?? "",
                overwrite: args.overwrite ?? false,
              }
            : null;

    if (!call) {
      console.error(`Unknown tool: ${args.tool}`);
      process.exit(1);
    }

    const res = await withTiming(
      { event: "tool_call", details: call } as any,
      async () => runTool(call),
    );

    await logEvent({
      level: res.ok ? "info" : "error",
      event: "tool_result",
      details: res,
    });

    if (res.ok) console.log(JSON.stringify(res.result, null, 2));
    else {
      console.error(res.error);
      process.exit(1);
    }
    return;
  }

  // 2) Help if nothing meaningful was passed
  const anyCommand =
    args.listSessions ||
    !!args.showSession ||
    !!args.clearSession ||
    !!args.exportSession ||
    args.pruneDays != null;

  if (
    !args.input &&
    !args.heartbeat &&
    !args.toolloop &&
    !anyCommand &&
    args.cmd !== "run"
  ) {
    printHelp();
    return;
  }

  // 3) Session commands (no session creation needed)
  const didSessionCmd = await withTiming({ event: "cmd" } as any, async () =>
    handleSessionCommands(args),
  ).catch((e) => {
    console.error(e?.stack ?? e);
    return false;
  });

  if (didSessionCmd) {
    await logEvent({ level: "info", event: "cmd_done" });
    return;
  }

  // 4) Run command (OpenClaw runner, JSON-friendly)
  if (args.cmd === "run") {
    const purpose = toPurpose(args);
    const session = await getOrCreateSession(args.session);
    const meta = { session: session.id, purpose };

    // Build initial messages: session history + optional system + user input
    const messages: LlmMessage[] = toLlmMessagesFromSession(session);
    if (args.system) messages.unshift({ role: "system", content: args.system });
    messages.push({ role: "user", content: args.input });

    if (!args.provider) {
      const err = "Missing --provider (anthropic|grok|...) for run command";
      if (args.json) jsonOut({ ok: false, error: err });
      else console.error(err);
      process.exit(1);
    }

    const req: LlmRequest = {
      provider: args.provider,
      model: args.model ?? "", // provider will fallback to config if you allow empty; otherwise set explicit
      messages,
      maxOutputTokens: args.maxOutputTokens ?? 800,
      tools: ALL_TOOLS,
      temperature: 0.2,
      meta: { purpose, requestId: session.id },
    };

    // For automation: --yes auto-approves read/list only. Everything else denied.
    const approve = async (call: ToolCall) => {
      if (args.yes && isSafeToolName(call.name)) return true;
      return false;
    };

    try {
      const res = await withTiming(
        { ...meta, event: "run_toolloop" } as any,
        async () =>
          runToolLoop({
            request: req,
            limits: {
              maxSteps: args.maxSteps ?? 6,
              maxToolCalls: args.maxToolCalls ?? 12,
            },
            keepLastN: 60,
            approve,
          }),
      );
      // Persist conversation: append assistant final message to session (best-effort)
      // NOTE: Your session storage format may differ; adjust in memory/store if needed.
      // We at least save session "as is" to keep existing behavior consistent.
      await saveSession(session);

      const payload = {
        ok: true,
        sessionId: session.id,
        purpose,
        provider: res.final.provider,
        model: res.final.model,
        text: res.final.text,
        usage: res.usageTotal,
      };

      if (args.json) jsonOut(payload);
      else {
        console.log(
          `[session=${session.id}] [provider=${res.final.provider}/${res.final.model}]`,
        );
        console.log(res.final.text);
      }

      return;
    } catch (e: any) {
      const message = String(e?.message ?? e);

      await logEvent({
        level: "error",
        event: "run_error",
        ...meta,
        errorClass: classifyError(e),
        message,
      });

      if (args.json)
        jsonOut({ ok: false, error: message, errorClass: classifyError(e) });
      else console.error(e?.stack ?? e);

      process.exit(1);
    }
  }

  // 5) Normal interactive session + purpose + userInput
  const purpose: Purpose = toPurpose(args);
  const session = await getOrCreateSession(args.session);
  const userInput = args.heartbeat ? "ping" : args.input;
  const meta = { session: session.id, purpose };

  // 6) Toolloop interactive branch
  if (args.toolloop) {
    const rl = readline.createInterface({
      input: processStdin,
      output: processStdout,
    });

    const approve = async (call: ToolCall) => {
      console.log("\nTOOL REQUEST:");
      console.log(JSON.stringify(call, null, 2));

      const safeAutoApprove = args.yes && isSafeToolName(call.name);
      if (safeAutoApprove) {
        console.log("(auto-approved: safe tool via --yes)");
        return true;
      }

      if (call.name === "write_file" && args.yes) {
        return true;
      }

      const ans = (await rl.question("Approve this tool call? (y/n) "))
        .trim()
        .toLowerCase();
      return ans === "y" || ans === "yes";
    };

    try {
      // Build request messages from session + user input
      const messages: LlmMessage[] = toLlmMessagesFromSession(session);
      if (args.system)
        messages.unshift({ role: "system", content: args.system });
      messages.push({ role: "user", content: userInput });

      if (!args.provider) {
        rl.close();
        console.error(
          "Missing --provider for toolloop. Example: --provider anthropic",
        );
        process.exit(1);
      }

      const req: LlmRequest = {
        provider: args.provider,
        model: args.model ?? "",
        messages,
        maxOutputTokens: args.maxOutputTokens ?? 800,
        tools: ALL_TOOLS,
        temperature: 0.2,
        meta: { purpose, requestId: session.id },
      };

      const res = await withTiming(
        { ...meta, event: "toolloop_run" } as any,
        async () =>
          runToolLoop({
            request: req,
            limits: {
              maxSteps: args.maxSteps ?? 3,
              maxToolCalls: args.maxToolCalls ?? 12,
            },
            keepLastN: 60,
            approve,
          }),
      );

      session.messages = res.messages.slice(-200); // optional cap
      await saveSession(session);

      rl.close();
      await saveSession(session);

      console.log(
        `\n[session=${session.id}] [purpose=${purpose}] [provider=${res.final.provider}/${res.final.model}]`,
      );
      console.log(res.final.text);
      return;
    } catch (e: any) {
      rl.close();
      await logEvent({
        level: "error",
        event: "toolloop_error",
        ...meta,
        errorClass: classifyError(e),
        message: String(e?.message ?? e),
      });
      console.error(e?.stack ?? e);
      process.exit(1);
    }
  }

  // 7) Normal agent run (no tools)
  try {
    const res = await withTiming(
      { ...meta, event: "llm_call" } as any,
      async () =>
        runAgent(session, {
          purpose,
          input: userInput,
          system: args.system,
        }),
    );

    await saveSession(session);

    await logEvent({
      level: "info",
      event: "agent_result",
      ...meta,
      provider: `${res.provider}`,
      model: res.model,
    });

    console.log(
      `\n[session=${session.id}] [purpose=${purpose}] [provider=${res.provider}/${res.model}]`,
    );
    console.log(res.text);
  } catch (e: any) {
    await logEvent({
      level: "error",
      event: "agent_error",
      ...meta,
      errorClass: classifyError(e),
      message: String(e?.message ?? e),
    });
    console.error(e?.stack ?? e);
    process.exit(1);
  }
}
