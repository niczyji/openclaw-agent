// providers/grok.ts
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import type {
  AssistantMessage,
  LlmRequest,
  LlmResponse,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
import { makeUsage } from "../core/types.js";

function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim() === "1";
}

// NOTE: This must already exist in your codebase.
// If it's in a different file, keep your original import.

function toOpenAiInput(messages: LlmRequest["messages"]): string {
  // Most compatible form for xAI Responses: plain string input.
  // We serialize conversation into a single prompt.
  return messages
    .map((m: any) => {
      const role = String(m?.role ?? "user");
      const content =
        typeof m?.content === "string"
          ? m.content
          : Array.isArray(m?.content)
            ? m.content
                .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
                .join("")
            : String(m?.content ?? "");
      return `${role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

function getTraceId(req: any): string {
  const t = String(req?.traceId ?? req?.trace ?? "").trim();
  return t || `trace-${Date.now().toString(36)}`;
}

function dump(trace: string, name: string, obj: unknown) {
  try {
    const dir = "/tmp/openclaw";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${trace}.${name}.json`),
      JSON.stringify(obj, null, 2),
      "utf8",
    );
  } catch (e) {
    // Do not crash the agent for debug failures
    console.error("dump failed:", e);
  }
}

// -------------------------
// Tools conversion
// -------------------------
function toOpenAiTools(tools: readonly ToolDefinition[]) {
  // xAI (Grok) Responses tools:
  // { type: "function", name, description, parameters }
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

// -------------------------
// Response extraction
// -------------------------
function extractText(res: unknown): string {
  // OpenAI Responses API (and compatibles) may provide output_text.
  const r = res as { output_text?: unknown; output?: unknown };
  if (typeof r.output_text === "string" && r.output_text.length) {
    return r.output_text;
  }

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
  // Responses API tool calls appear in different shapes across providers.
  // Handle common patterns:
  // A) output[] item itself has type function_call/tool_call
  // B) output[].content[] has blocks with type function_call/tool_call
  const calls: ToolCall[] = [];
  const r = res as any;

  const out = r?.output;
  if (!Array.isArray(out)) return calls;

  for (const item of out) {
    const itemType = item?.type;

    // Pattern A
    if (itemType === "tool_call" || itemType === "function_call") {
      const id = String(item?.id ?? item?.call_id ?? "");
      const name = String(
        item?.name ??
          item?.tool_name ??
          item?.function?.name ??
          item?.function_name ??
          "",
      );

      const argsRaw =
        item?.arguments ??
        item?.args ??
        item?.input ??
        item?.function?.arguments ??
        item?.function?.args ??
        {};

      const argumentsJson =
        typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw);

      if (name) {
        calls.push({
          id: id || `${name}:${calls.length}`,
          name,
          argumentsJson,
        });
      }
      continue;
    }

    // Pattern B
    const content = item?.content;
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      const type = c?.type;
      if (type !== "tool_call" && type !== "function_call") continue;

      const id = String(c?.id ?? c?.call_id ?? "");
      const name = String(
        c?.name ?? c?.tool_name ?? c?.function?.name ?? c?.function_name ?? "",
      );

      const argsRaw =
        c?.arguments ??
        c?.args ??
        c?.input ??
        c?.function?.arguments ??
        c?.function?.args ??
        {};

      const argumentsJson =
        typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw);

      if (name) {
        calls.push({
          id: id || `${name}:${calls.length}`,
          name,
          argumentsJson,
        });
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

// -------------------------
// Main
// -------------------------
export async function grokChat(req: LlmRequest): Promise<LlmResponse> {
  if (!config.grok.apiKey) {
    throw new Error("GROK_API_KEY not set. Set it in .env to enable Grok.");
  }

  const traceId = getTraceId(req as any);

  const client = new OpenAI({
    apiKey: config.grok.apiKey,
    baseURL: config.grok.baseUrl,
  });

  // Hard enforcement
  const maxOutputTokens = Math.max(1, Math.trunc(req.maxOutputTokens));

  if (req.tools?.length) {
    console.log(
      "GROK tools[0] =",
      JSON.stringify(toOpenAiTools(req.tools)[0], null, 2),
    );
  }

  // Debug dump request "shape" (no secrets)
  dump(traceId, "grok.request.shape", {
    model: req.model || config.grok.model,
    temperature: req.temperature ?? 0.2,
    max_output_tokens: maxOutputTokens,
    tools_count: req.tools?.length ?? 0,
    force_tool_choice: envFlag("GROK_FORCE_TOOL_CHOICE"),
  });

  const forceTool = envFlag("GROK_FORCE_TOOL_CHOICE");

  const res = await client.responses.create({
    model: req.model || config.grok.model,
    input: toOpenAiInput(req.messages),
    temperature: req.temperature ?? 0.2,
    max_output_tokens: maxOutputTokens,
    ...(req.tools && req.tools.length
      ? { tools: toOpenAiTools(req.tools) }
      : {}),
    ...(forceTool && req.tools && req.tools.length
      ? { tool_choice: { type: "function", name: req.tools[0].name } }
      : {}),
  });

  // Dump raw response so we can adapt parsing to reality
  dump(traceId, "grok.response.raw", res);

  const outTypes = Array.isArray((res as any)?.output)
    ? (res as any).output.map((x: any) => x?.type).filter(Boolean)
    : [];
  console.log("GROK trace", traceId, "output types =", outTypes);

  const text = extractText(res);
  const toolCalls = extractToolCalls(res);

  dump(traceId, "grok.extract.text", { text });
  dump(traceId, "grok.extract.toolcalls", toolCalls);

  const message: AssistantMessage = toolCalls.length
    ? { role: "assistant", content: text, toolCalls }
    : { role: "assistant", content: text };

  // Best-effort finish reason
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
