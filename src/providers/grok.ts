// providers/grok.ts
import OpenAI from "openai";
import { config } from "../config.js";
import type {
  AssistantMessage,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
import { makeUsage } from "../core/types.js";

function toOpenAiInput(messages: readonly LlmMessage[]) {
  // For OpenAI Responses API, input can be "messages-like" objects.
  // We keep it simple: system/user/assistant/tool all become role+content messages.
  // If you later want true tool calling in Responses API, you'll map ToolDefinitions too.
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        content: m.content,
        // Some endpoints accept name/tool_call_id; harmless if ignored.
        name: m.name,
        tool_call_id: m.toolCallId,
      };
    }

    if (m.role === "assistant") {
      return {
        role: "assistant" as const,
        content: m.content,
      };
    }

    if (m.role === "system") {
      return {
        role: "system" as const,
        content: m.content,
      };
    }

    return {
      role: "user" as const,
      content: m.content,
    };
  });
}

function extractText(res: unknown): string {
  // OpenAI Responses API (and some compatibles) may provide output_text.
  const r = res as { output_text?: unknown; output?: unknown };
  if (typeof r.output_text === "string" && r.output_text.length)
    return r.output_text;

  const out = r.output;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const item of out) {
      const content = (item as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        const maybeText = (c as { text?: unknown })?.text;
        if (typeof maybeText === "string") parts.push(maybeText);
      }
    }
    const joined = parts.join("");
    if (joined.length) return joined;
  }

  return "(no response)";
}

function extractToolCalls(res: unknown): ToolCall[] {
  // Responses API can expose tool calls in different shapes depending on provider.
  // We'll implement a conservative extractor:
  // - look for output[].content[] blocks of type "tool_call" / "function_call" variants if present.
  const calls: ToolCall[] = [];
  const r = res as { output?: unknown };

  if (!Array.isArray(r.output)) return calls;

  for (const item of r.output) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      const type = (c as { type?: unknown })?.type;
      if (typeof type !== "string") continue;

      // Some compatibles use "tool_call" or "function_call"
      if (type === "tool_call" || type === "function_call") {
        const id = String((c as { id?: unknown })?.id ?? "");
        const name = String((c as { name?: unknown })?.name ?? "");
        const args =
          (c as { arguments?: unknown; args?: unknown })?.arguments ??
          (c as { arguments?: unknown; args?: unknown })?.args ??
          {};
        const argumentsJson =
          typeof args === "string" ? args : JSON.stringify(args);

        if (id && name) {
          calls.push({ id, name, argumentsJson });
        }
      }
    }
  }

  return calls;
}

function normalizeUsage(res: unknown) {
  const r = res as { usage?: unknown };
  const u = r.usage as
    | {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
      }
    | undefined;

  if (!u) return makeUsage(0, 0);

  // ChatCompletions-like
  if (
    typeof u.prompt_tokens === "number" &&
    typeof u.completion_tokens === "number"
  ) {
    return makeUsage(u.prompt_tokens, u.completion_tokens);
  }

  // Responses-like
  if (
    typeof u.input_tokens === "number" &&
    typeof u.output_tokens === "number"
  ) {
    return makeUsage(u.input_tokens, u.output_tokens);
  }

  return makeUsage(0, 0);
}

function toOpenAiTools(tools: readonly ToolDefinition[]) {
  // Responses API tools are usually:
  // { type: "function", function: { name, description, parameters } }
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function grokChat(req: LlmRequest): Promise<LlmResponse> {
  if (!config.grok.apiKey) {
    throw new Error("GROK_API_KEY not set. Set it in .env to enable Grok.");
  }

  const client = new OpenAI({
    apiKey: config.grok.apiKey,
    baseURL: config.grok.baseUrl,
  });

  // Hard enforcement
  const maxOutputTokens = Math.max(1, Math.trunc(req.maxOutputTokens));

  const res = await client.responses.create({
    model: req.model || config.grok.model,
    input: toOpenAiInput(req.messages),
    temperature: req.temperature ?? 0.2,
    max_output_tokens: maxOutputTokens,
    ...(req.tools && req.tools.length
      ? { tools: toOpenAiTools(req.tools) }
      : {}),
  });

  const text = extractText(res);
  const toolCalls = extractToolCalls(res);

  const message: AssistantMessage = toolCalls.length
    ? { role: "assistant", content: text, toolCalls }
    : { role: "assistant", content: text };

  // We often don’t get a reliable finish reason from compatibles; best-effort.
  // If res has "status" or "finish_reason", you can map it later.
  const finishReason = toolCalls.length ? "tool_call" : "unknown";

  const usage = normalizeUsage(res);

  return {
    provider: "grok",
    model:
      (res as { model?: string }).model ?? (req.model || config.grok.model),
    text,
    message,
    usage,
    finishReason,
    responseId: (res as { id?: string }).id,
  };
}
