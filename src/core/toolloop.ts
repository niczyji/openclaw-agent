import type { Purpose, ChatMessage } from "./types.ts";
import { chat } from "./router.ts";
import type { Session } from "../memory/store.ts";
import type { ToolCall } from "../tools/types.ts";
import { runTool } from "../tools/registry.ts";
import { logEvent, withTiming } from "../logger.ts";

export type ToolLoopOptions = {
  purpose: Purpose;
  input: string;
  system?: string;
  keepLastN?: number;
  maxSteps?: number; // tool steps
  approve: (call: ToolCall) => Promise<boolean>;
};

function extractToolCall(text: string): ToolCall | null {
  // Expected exact format:
  // ```toolcall
  // { "tool": "...", ... }
  // ```
  const m = text.match(/```toolcall\s*([\s\S]*?)\s*```/i);
  if (!m) return null;

  try {
    const obj = JSON.parse(m[1]);
    if (!obj?.tool) return null;
    return obj as ToolCall;
  } catch {
    return null;
  }
}

function toolSystemPrompt(base?: string) {
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

export async function runAgentToolLoop(session: Session, opts: ToolLoopOptions) {
  const keep = opts.keepLastN ?? 20;
  const maxSteps = opts.maxSteps ?? 3;

  const history = session.messages.slice(-keep);

  const messages: ChatMessage[] = [
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
    const res = await withTiming(
      { event: "llm_step", session: session.id, purpose: opts.purpose, details: { step } } as any,
      async () => chat({ purpose: opts.purpose, messages, temperature: temp }),
    );

    lastProvider = res.provider;
    lastModel = res.model;

    const call = extractToolCall(res.text);

    if (!call) {
      // Final answer
      finalText = res.text;

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

      return { text: finalText, provider: lastProvider, model: lastModel };
    }

    if (call.tool === "write_file") {
      if (writesUsed >= maxWrites) {
        messages.push({
          role: "assistant",
          content: "Tool request rejected: write_file budget exceeded for this run.",
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
      // Tell model tool was denied and ask it to continue without tools
      messages.push({ role: "assistant", content: "Tool request denied by user." });
      messages.push({
        role: "user",
        content: "Tool request denied. Continue without tools and answer with best effort.",
      });
      continue;
    }

    const toolRes = await withTiming(
      {
        event: "tool_exec",
        session: session.id,
        purpose: opts.purpose,
        details: { step, call },
      } as any,
      async () => runTool(call),
    );

    await logEvent({
      level: toolRes.ok ? "info" : "error",
      event: "tool_result",
      session: session.id,
      purpose: opts.purpose,
      details: { step, toolRes },
    });

    // write budget zählen
    if (call.tool === "write_file" && toolRes.ok) {
      writesUsed++;
    }

    // Feed result back to model
    messages.push({ role: "assistant", content: `Tool call executed: ${JSON.stringify(call)}` });
    messages.push({
      role: "user",
      content: `TOOL_RESULT:\n${JSON.stringify(toolRes, null, 2)}`,
    });
  }

  // Exhausted tool steps — force final answer
  const res = await chat({
    purpose: opts.purpose,
    messages: [
      ...messages,
      {
        role: "user",
        content: "Max tool steps reached. Provide the best final answer now without further tools.",
      },
    ],
    temperature: temp,
  });

  finalText = res.text;
  session.messages.push({ role: "user", content: opts.input });
  session.messages.push({ role: "assistant", content: finalText });

  return { text: finalText, provider: res.provider, model: res.model };
}
