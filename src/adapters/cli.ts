import { promises as fs } from "node:fs";
import readline from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";

import { getOrCreateSession, saveSession } from "../memory/store.ts";
import { runAgent } from "../core/agent.ts";
import type { Purpose } from "../core/types.ts";

import { runTool } from "../tools/registry.ts";
import type { ToolName } from "../tools/types.ts";

import { runAgentToolLoop } from "../core/toolloop.ts";

import {
  listSessions,
  readSessionFile,
  deleteSession,
  exportSessionMarkdown,
  pruneSessionsOlderThan,
} from "../memory/sessions.ts";

import { logEvent, withTiming, classifyError } from "../logger.ts";

type Args = {
  dev: boolean;
  heartbeat: boolean;
  session?: string;
  system?: string;

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

  // toolloop
  toolloop: boolean;
  steps?: number;
  yes: boolean;

  // free text input
  input: string;
};

function parseArgs(argv: string[]): Args {
  let dev = false;
  let heartbeat = false;
  let session: string | undefined;
  let system: string | undefined;

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
  let steps: number | undefined;
  let yes = false;

  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--dev") dev = true;
    else if (a === "--heartbeat") heartbeat = true;
    else if (a === "--session") session = argv[++i];
    else if (a === "--system") system = argv[++i];
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
    else if (a === "--steps") steps = Number(argv[++i]);
    else if (a === "--yes") yes = true;
    else rest.push(a);
  }

  const input = rest.join(" ").trim();

  return {
    dev,
    heartbeat,
    session,
    system,

    tool,
    path: toolPath,
    content,
    overwrite,

    listSessions: listSessionsFlag,
    showSession,
    clearSession,
    exportSession,
    out,
    pruneDays,

    toolloop,
    steps,
    yes,

    input,
  };
}

function printHelp() {
  console.log(
    `
Usage:
  npm run agent -- "Hello world"
  npm run agent -- --dev "Review code..."
  npm run agent -- --heartbeat
  npm run agent -- --session my-session "Continue..."

Manual tools:
  npm run agent -- --tool list_dir  --path src
  npm run agent -- --tool read_file --path src/main.ts
  npm run agent -- --tool write_file --path data/outputs/x.txt --content "hi" [--overwrite]

Session tools:
  npm run agent -- --list-sessions
  npm run agent -- --show-session <id>
  npm run agent -- --clear-session <id>
  npm run agent -- --export-session <id> --out session.md
  npm run agent -- --prune-days 30

Toolloop (with confirmation):
  npm run agent -- --toolloop "List src and explain components"
  npm run agent -- --toolloop --dev "Review repo and suggest improvements"
  npm run agent -- --toolloop --steps 2 "..."
  npm run agent -- --toolloop --yes "auto-approve safe tools only (read_file/list_dir); write_file always asks"
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

    const res = await withTiming({ event: "tool_call", details: call } as any, async () =>
      runTool(call),
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

  if (!args.input && !args.heartbeat && !args.toolloop && !anyCommand) {
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

  // 4) Now create session + purpose + userInput
  const purpose: Purpose = args.heartbeat ? "heartbeat" : args.dev ? "dev" : "default";
  const session = await getOrCreateSession(args.session);
  const userInput = args.heartbeat ? "ping" : args.input;

  const meta = { session: session.id, purpose };

  // 5) Toolloop branch
  if (args.toolloop) {
    const rl = readline.createInterface({ input: processStdin, output: processStdout });

    const approve = async (call: any) => {
      console.log("\nTOOL REQUEST:");
      console.log(JSON.stringify(call, null, 2));

      // --yes auto-approves only "safe" tools
      const safeAutoApprove = args.yes && (call.tool === "read_file" || call.tool === "list_dir");
      if (safeAutoApprove) {
        console.log("(auto-approved: safe tool via --yes)");
        return true;
      }

      // write_file (and everything else) always requires manual confirmation
      if (call.tool === "write_file" && args.yes) {
        console.log("(NOTE: --yes does NOT auto-approve write_file; manual approval required)");
      }

      const ans = (await rl.question("Approve this tool call? (y/n) ")).trim().toLowerCase();
      return ans === "y" || ans === "yes";
    };

    try {
      const res = await withTiming({ ...meta, event: "toolloop_run" } as any, async () =>
        runAgentToolLoop(session, {
          purpose,
          input: userInput,
          system: args.system,
          maxSteps: args.steps ?? 3,
          approve,
        }),
      );

      rl.close();
      await saveSession(session);

      console.log(
        `\n[session=${session.id}] [purpose=${purpose}] [provider=${res.provider}/${res.model}]`,
      );
      console.log(res.text);
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

  // 6) Normal agent run
  try {
    const res = await withTiming({ ...meta, event: "llm_call" } as any, async () =>
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
