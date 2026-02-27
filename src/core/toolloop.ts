// core/toolloop.ts
import type {
  LlmMessage,
  LlmRequest,
  LlmResponse,
  ToolCall,
  ToolMessage,
  Usage,
  Purpose,
} from "./types.js";
import { makeUsage } from "./types.js";
import { chat } from "./router.js";

import {
  createBudget,
  bookModelCall,
  bookToolCall,
  bookUsage,
  canCallModel,
  type ToolKind,
} from "./budget.js";

import type { Session } from "../memory/store.js";
import { runToolFromModelCall } from "../tools/registry.js";
import { classifyTool } from "../tools/policy.js";
import { ALL_TOOLS } from "../tools/definitions.js";

// If your project doesn't have this, delete the logEvent calls below.
import { logEvent } from "../logger.js";

export type ToolLoopOptions = Readonly<{
  request: Omit<LlmRequest, "messages"> & { messages: readonly LlmMessage[] };

  limits?: Readonly<{
    maxSteps?: number;
    maxToolCalls?: number;
    maxTotalTokens?: number;
    maxTotalInputTokens?: number;
    maxTotalOutputTokens?: number;
    maxReads?: number;
    maxWrites?: number;
  }>;

  keepLastN?: number;

  approve: (call: ToolCall) => Promise<boolean>;
}>;

export type ToolLoopResult = Readonly<{
  final: LlmResponse;
  messages: readonly LlmMessage[];
  usageTotal: Usage;
}>;

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

function toolKind(name: string): ToolKind {
  try {
    return classifyTool(name);
  } catch {
    return "other";
  }
}

function safeMaxOutputTokens(x: unknown, fallback = 2048): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.trunc(n));
}

export async function runToolLoop(
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const maxSteps = opts.limits?.maxSteps ?? 6;
  const maxToolCalls = opts.limits?.maxToolCalls ?? 12;

  // The toolloop needs to pass purpose into tools/policy.
  const purpose: Purpose = opts.request.purpose === "dev" ? "dev" : "runtime";

  let budget = createBudget({
    maxSteps,
    maxToolCalls,
    maxTotalTokens: opts.limits?.maxTotalTokens,
    maxTotalInputTokens: opts.limits?.maxTotalInputTokens,
    maxTotalOutputTokens: opts.limits?.maxTotalOutputTokens,
    maxReads: opts.limits?.maxReads,
    maxWrites: opts.limits?.maxWrites,
  });

  let messages: readonly LlmMessage[] = opts.request.messages;
  let usageTotal: Usage = makeUsage(0, 0);

  let lastResponse: LlmResponse | null = null;

  while (true) {
    if (!canCallModel(budget)) {
      if (lastResponse) return { final: lastResponse, messages, usageTotal };
      throw new Error("Budget exhausted before first model call");
    }

    budget = bookModelCall(budget);

    const req: LlmRequest = {
      ...opts.request,
      messages,
      maxOutputTokens: safeMaxOutputTokens(opts.request.maxOutputTokens, 2048),
      tools: opts.request.tools ?? ALL_TOOLS,
    };

    const res = await chat(req);
    lastResponse = res;

    usageTotal = addUsage(usageTotal, res.usage);
    budget = bookUsage(budget, res.usage);

    messages = clampHistory([...messages, res.message], opts.keepLastN);

    const toolCalls = res.message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return { final: res, messages, usageTotal };
    }

    for (const call of toolCalls) {
      const kind = toolKind(call.name);
      budget = bookToolCall(budget, kind);

      // Approve UX (human-in-the-loop)
      logEvent?.({
        level: "info",
        event: "toolloop_approve_prompt",
        details: { tool: call.name, id: call.id },
      });

      const approved = await opts.approve(call);

      if (!approved) {
        const denied: ToolMessage = {
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify(
            {
              ok: false,
              tool: call.name,
              error: "Tool call denied by policy/approval.",
            },
            null,
            2,
          ),
        };
        messages = clampHistory([...messages, denied], opts.keepLastN);
        continue;
      }

      let toolOut: string;
      try {
        toolOut = await runToolFromModelCall(
          {
            id: call.id,
            name: call.name,
            argumentsJson: call.argumentsJson,
          },
          { purpose },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolOut = JSON.stringify(
          { ok: false, tool: call.name, error: msg },
          null,
          2,
        );
      }

      const toolMsg: ToolMessage = {
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: toolOut,
      };

      messages = clampHistory([...messages, toolMsg], opts.keepLastN);
    }
  }
}

// Legacy-friendly wrapper for adapters (CLI/Telegram)
export async function runAgentToolLoop(
  session: Session,
  opts: {
    purpose: Purpose;
    input: string;
    system?: string;
    maxSteps?: number;
    keepLastN?: number;
    provider?: any; // ProviderName if you have it
    model?: string;
    approve: (call: ToolCall) => Promise<boolean>;
  },
): Promise<LlmResponse> {
  const keep = opts.keepLastN ?? 200;
  const history = session.messages.slice(-keep) as unknown as LlmMessage[];

  const messages: LlmMessage[] = [
    {
      role: "system",
      content:
        opts.system ??
        "You are a helpful assistant. Keep answers concise unless asked otherwise.",
    },
    ...history,
    { role: "user", content: opts.input },
  ];

  const { final } = await runToolLoop({
    request: {
      purpose: opts.purpose,
      provider: opts.provider,
      model: opts.model,
      messages,
      maxOutputTokens: 2048,
      // tools omitted => toolloop uses ALL_TOOLS fallback
    } as any,
    limits: { maxSteps: opts.maxSteps ?? 3 },
    keepLastN: keep,
    approve: opts.approve,
  });

  // Persist the actual turn (minimal; you can refine later)
  session.messages.push({ role: "user", content: opts.input } as any);
  session.messages.push({ role: "assistant", content: final.text } as any);

  return final;
}
