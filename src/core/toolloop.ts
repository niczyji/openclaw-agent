// core/toolloop.ts
import type {
  LlmMessage,
  LlmRequest,
  LlmResponse,
  ToolCall,
  ToolMessage,
  Usage,
} from "./types";
import { makeUsage } from "./types";
import { chat } from "./router";
import {
  createBudget,
  bookModelCall,
  bookToolCall,
  bookUsage,
  canCallModel,
  type ToolKind,
} from "./budget";

import { runToolFromModelCall } from "../tools/registry";
import { classifyTool } from "../tools/policy";
import { ALL_TOOLS } from "../tools/definitions";

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

export async function runToolLoop(
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const maxSteps = opts.limits?.maxSteps ?? 6;
  const maxToolCalls = opts.limits?.maxToolCalls ?? 12;

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
      maxOutputTokens: Math.max(1, Math.trunc(opts.request.maxOutputTokens)),
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

      const approved = await opts.approve(call);

      if (!approved) {
        const denied: ToolMessage = {
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify(
            { ok: false, error: "Tool call denied by policy/approval." },
            null,
            2,
          ),
        };
        messages = clampHistory([...messages, denied], opts.keepLastN);
        continue;
      }

      let toolOut: string;
      try {
        toolOut = await runToolFromModelCall({
          name: call.name,
          argumentsJson: call.argumentsJson,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toolOut = JSON.stringify({ ok: false, error: msg }, null, 2);
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
