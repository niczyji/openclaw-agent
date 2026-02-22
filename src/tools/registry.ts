import { promises as fs } from "node:fs";
import path from "node:path";
import { assertAllowedPath } from "./policy.ts";
import type { ToolCall, ToolResult } from "./types.ts";

const MAX_READ_BYTES = 200_000; // 200 KB
const MAX_DIR_ENTRIES = 200;

function redactSecrets(text: string): string {
  // mask common secret patterns
  const patterns: Array<[RegExp, string]> = [
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

export async function runTool(call: ToolCall): Promise<ToolResult> {
  try {
    if (call.tool === "read_file") {
      const full = assertAllowedPath(call.path);

      const st = await fs.stat(full);
      if (st.size > MAX_READ_BYTES) {
        return {
          ok: false,
          tool: call.tool,
          error: `File too large (${st.size} bytes). Max is ${MAX_READ_BYTES}.`,
        };
      }

      let content = await fs.readFile(full, "utf8");
      content = redactSecrets(content);

      const MAX_CHARS = 4000;
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

      const entries = await fs.readdir(full, { withFileTypes: true });
      const sliced = entries.slice(0, MAX_DIR_ENTRIES);

      return {
        ok: true,
        tool: call.tool,
        result: {
          path: call.path,
          totalEntries: entries.length,
          returnedEntries: sliced.length,
          entries: sliced.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
        },
      };
    }

    if (call.tool === "write_file") {
      const full = assertAllowedPath(call.path);

      // write_file restricted to data/outputs/*
      const outRoot = assertAllowedPath("data/outputs");
      if (!full.startsWith(outRoot + path.sep) && full !== outRoot) {
        throw new Error(`write_file restricted to data/outputs/* (got: ${call.path})`);
      }

      await fs.mkdir(path.dirname(full), { recursive: true });

      if (!call.overwrite) {
        try {
          await fs.access(full);
          throw new Error(`File exists (set --overwrite): ${call.path}`);
        } catch (e: any) {
          if (e?.code !== "ENOENT") throw e;
        }
      }

      await fs.writeFile(full, call.content, "utf8");
      return { ok: true, tool: call.tool, result: { path: call.path, bytes: call.content.length } };
    }

    return { ok: false, tool: call.tool as any, error: "Unknown tool" };
  } catch (e: any) {
    return { ok: false, tool: call.tool, error: String(e?.message ?? e) };
  }
}
