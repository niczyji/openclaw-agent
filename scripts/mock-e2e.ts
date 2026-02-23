// scripts/mock-e2e.ts
import type { LlmRequest, LlmResponse, ToolCall } from "../src/core/types.js";
import { makeUsage } from "../src/core/types.js";
import { runToolLoop } from "../src/core/toolloop.js";
import { ALL_TOOLS } from "../src/tools/definitions.js";

// ---- Mock "chat" implementation ----
// IMPORTANT:
// This assumes your core/toolloop.ts imports chat() from core/router.ts.
// For this mock run, we bypass router by calling a local loop that uses our mock.
// Easiest path: create a small local loop that mimics your toolloop but swaps chat().
// To avoid changing your core code, we provide a tiny "runToolLoopWithChat" here.

import {
  createBudget,
  bookModelCall,
  bookToolCall,
  bookUsage,
  canCallModel,
} from "../src/core/budget.js";
import type { LlmMessage, ToolMessage, Usage } from "../src/core/types.js";
import { classifyTool } from "../src/tools/policy.js";
import { runToolFromModelCall } from "../src/tools/registry.js";

type ChatFn = (req: LlmRequest) => Promise<LlmResponse>;

function clampHistory(
  msgs: readonly LlmMessage[],
  keepLastN?: number,
): readonly LlmMessage[] {
  if (!keepLastN || keepLastN <= 0) return msgs;
  if (msgs.length <= keepLastN) return msgs;
  return msgs.slice(msgs.length - keepLastN);
}
function addUsage(a: Usage, b: Usage): Usage {
  return makeUsage(
    a.inputTokens + b.inputTokens,
    a.outputTokens + b.outputTokens,
  );
}

async function runToolLoopWithChat(opts: {
  request: LlmRequest;
  approve: (call: ToolCall) => Promise<boolean>;
  chat: ChatFn;
  keepLastN?: number;
  limits?: {
    maxSteps?: number;
    maxToolCalls?: number;
  };
}): Promise<{
  final: LlmResponse;
  messages: readonly LlmMessage[];
  usageTotal: Usage;
}> {
  const maxSteps = opts.limits?.maxSteps ?? 4;
  const maxToolCalls = opts.limits?.maxToolCalls ?? 6;

  let budget = createBudget({ maxSteps, maxToolCalls });
  let messages: readonly LlmMessage[] = opts.request.messages;
  let usageTotal: Usage = makeUsage(0, 0);
  let last: LlmResponse | null = null;

  while (true) {
    if (!canCallModel(budget)) {
      if (last) return { final: last, messages, usageTotal };
      throw new Error("Budget exhausted before first model call");
    }

    budget = bookModelCall(budget);

    const res = await opts.chat({ ...opts.request, messages });
    last = res;

    usageTotal = addUsage(usageTotal, res.usage);
    budget = bookUsage(budget, res.usage);

    messages = clampHistory([...messages, res.message], opts.keepLastN);

    const toolCalls = res.message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return { final: res, messages, usageTotal };
    }

    for (const call of toolCalls) {
      budget = bookToolCall(budget, classifyTool(call.name));

      const approved = await opts.approve(call);
      if (!approved) {
        const denied: ToolMessage = {
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify(
            { ok: false, error: "Denied by approval" },
            null,
            2,
          ),
        };
        messages = clampHistory([...messages, denied], opts.keepLastN);
        continue;
      }

      const out = await runToolFromModelCall({
        name: call.name,
        argumentsJson: call.argumentsJson,
      });

      const toolMsg: ToolMessage = {
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: out,
      };

      messages = clampHistory([...messages, toolMsg], opts.keepLastN);
    }
  }
}

// ---- The mock model ----
// Step 1: request list_dir(notes)
// Step 2: after tool result, request read_file(notes/test.txt)
// Step 3: after tool result, produce final summary

function lastToolMessage(msgs: readonly LlmMessage[]): ToolMessage | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "tool") return m;
  }
  return undefined;
}

const mockChat: ChatFn = async (req) => {
  const toolMsg = lastToolMessage(req.messages);

  // If no tool results yet, call list_dir
  if (!toolMsg) {
    return {
      provider: req.provider,
      model: req.model ?? "mock",
      text: "",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "t1",
            name: "list_dir",
            argumentsJson: JSON.stringify({ path: "notes" }),
          },
        ],
      },
      usage: makeUsage(10, 1),
      finishReason: "tool_call",
      responseId: "mock-1",
    };
  }

  // If last tool was list_dir, then read_file
  if (toolMsg.name === "list_dir") {
    return {
      provider: req.provider,
      model: req.model ?? "mock",
      text: "",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "t2",
            name: "read_file",
            argumentsJson: JSON.stringify({ path: "notes/test.txt" }),
          },
        ],
      },
      usage: makeUsage(8, 1),
      finishReason: "tool_call",
      responseId: "mock-2",
    };
  }

  // If last tool was read_file, return final answer
  if (toolMsg.name === "read_file") {
    return {
      provider: req.provider,
      model: req.model ?? "mock",
      text: "OK: listed notes and read notes/test.txt. Summary: it contains two lines of greeting text.",
      message: {
        role: "assistant",
        content:
          "OK: listed notes and read notes/test.txt. Summary: it contains two lines of greeting text.",
      },
      usage: makeUsage(12, 20),
      finishReason: "stop",
      responseId: "mock-3",
    };
  }

  // Fallback
  return {
    provider: req.provider,
    model: req.model ?? "mock",
    text: "Unexpected state",
    message: { role: "assistant", content: "Unexpected state" },
    usage: makeUsage(1, 1),
    finishReason: "unknown",
  };
};

async function main() {
  // Initial prompt (doesn't matter much for mock)
  const messages: LlmMessage[] = [
    { role: "system", content: "You are a tool-using assistant." },
    {
      role: "user",
      content: "Please list notes, then read notes/test.txt and summarize.",
    },
  ];

  const req: LlmRequest = {
    provider: "grok",
    model: "mock",
    messages,
    maxOutputTokens: 200,
    tools: ALL_TOOLS,
    temperature: 0,
  };

  const result = await runToolLoopWithChat({
    request: req,
    chat: mockChat,
    approve: async () => true,
    limits: { maxSteps: 6, maxToolCalls: 6 },
  });

  console.log("=== FINAL ===");
  console.log(result.final.text);
  console.log("\n=== USAGE TOTAL ===");
  console.log(result.usageTotal);
  console.log("\n=== MESSAGE COUNT ===");
  console.log(result.messages.length);
  console.log("\n=== LAST 3 MESSAGES ===");
  console.log(result.messages.slice(-3));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
