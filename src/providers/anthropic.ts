// providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import type {
  AssistantMessage,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  ToolCall,
  ToolDefinition,
} from "../core/types";
import { makeUsage } from "../core/types";

// Helper types (keep strict, avoid any)
type AnthropicMsgParam = {
  role: "user" | "assistant";
  content: string | readonly unknown[];
};

function safeParseJsonObject(json: string): Record<string, unknown> {
  const v = JSON.parse(json) as unknown;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function toAnthropic(messages: readonly LlmMessage[]): {
  system?: string;
  msgs: AnthropicMsgParam[];
} {
  const systemParts: string[] = [];
  const msgs: AnthropicMsgParam[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }

    if (m.role === "user") {
      msgs.push({ role: "user", content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      // If assistant contains tool calls, we MUST send tool_use blocks back to Anthropic
      const tc = m.toolCalls ?? [];
      if (tc.length === 0) {
        msgs.push({ role: "assistant", content: m.content });
        continue;
      }

      const blocks: unknown[] = [];

      if (m.content && m.content.trim().length) {
        blocks.push({ type: "text", text: m.content });
      }

      for (const call of tc) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: safeParseJsonObject(call.argumentsJson),
        });
      }

      msgs.push({ role: "assistant", content: blocks });
      continue;
    }

    // m.role === "tool"
    msgs.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        },
      ],
    });
  }

  const system = systemParts.length ? systemParts.join("\n\n") : undefined;

  if (!msgs.some((x) => x.role === "user")) {
    msgs.unshift({ role: "user", content: "Hello" });
  }

  return { system, msgs };
}

function toAnthropicTools(
  tools: readonly ToolDefinition[],
): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as unknown as Record<string, unknown>,
  }));
}

function extractText(res: Anthropic.Messages.Message): string {
  const parts: string[] = [];
  for (const block of res.content) {
    if (block.type === "text") parts.push(block.text);
  }
  const joined = parts.join("");
  return joined.length ? joined : "(no response)";
}

function extractToolCalls(res: Anthropic.Messages.Message): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of res.content) {
    if (block.type === "tool_use") {
      calls.push({
        id: block.id,
        name: block.name,
        argumentsJson: JSON.stringify(block.input ?? {}),
      });
    }
  }
  return calls;
}

export async function anthropicChat(req: LlmRequest): Promise<LlmResponse> {
  if (!config.anthropic.apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set. Set it in .env to enable Anthropic.",
    );
  }

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const { system, msgs } = toAnthropic(req.messages);

  const maxTokens = Math.max(1, Math.trunc(req.maxOutputTokens));

  const res = await client.messages.create({
    model: req.model ?? config.anthropic.model,
    max_tokens: maxTokens,
    temperature: req.temperature ?? 0.2,
    ...(system ? { system } : {}),
    messages: msgs as unknown as Anthropic.Messages.MessageParam[],
    ...(req.tools && req.tools.length
      ? { tools: toAnthropicTools(req.tools) }
      : {}),
  });

  const text = extractText(res);
  const toolCalls = extractToolCalls(res);

  const message: AssistantMessage = toolCalls.length
    ? { role: "assistant", content: text, toolCalls }
    : { role: "assistant", content: text };

  const finishReason =
    res.stop_reason === "end_turn"
      ? "stop"
      : res.stop_reason === "max_tokens"
        ? "length"
        : res.stop_reason === "tool_use"
          ? "tool_call"
          : "unknown";

  return {
    provider: "anthropic",
    model: res.model,
    text,
    message,
    usage: makeUsage(
      res.usage?.input_tokens ?? 0,
      res.usage?.output_tokens ?? 0,
    ),
    finishReason,
    responseId: res.id,
  };
}
