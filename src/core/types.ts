// core/types.ts
// Single source of truth for *internal* LLM request/response typing.
// Goal: strict TS, provider-agnostic, one usage format, no "prompt_tokens" leaking in.

export type ProviderId = "grok" | "anthropic" | "openai" | "mistral" | "local";

export type LlmRole = "system" | "user" | "assistant" | "tool";

/**
 * Internal canonical usage format.
 * Everything provider-specific must be normalized into this shape.
 */
export type Usage = Readonly<{
  /** Tokens sent *to* the model (includes system + user + tool messages, etc.) */
  inputTokens: number;
  /** Tokens generated *by* the model */
  outputTokens: number;
  /** inputTokens + outputTokens */
  totalTokens: number;

  /**
   * Optional fields for providers that expose more detail.
   * Keep these optional so we don't create fake precision.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}>;

/**
 * Optional cost estimate normalized to a single currency (USD) unless you enforce another.
 * (You can compute this in provider adapter or logger; it is NOT required.)
 */
export type Cost = Readonly<{
  currency: "USD" | "EUR";
  /** Total cost for this call (best-effort). */
  total: number;
  /** Optional breakdown */
  input?: number;
  output?: number;
}>;

export type FinishReason =
  | "stop"
  | "length"
  | "tool_call"
  | "content_filter"
  | "error"
  | "unknown";

/**
 * Tool call produced by the model (provider-agnostic).
 * - name must match a registered tool.
 * - argumentsJson is always a JSON string (not an object) to avoid "any" and preserve exactness.
 */
export type ToolCall = Readonly<{
  id: string; // provider id or generated id
  name: string;
  argumentsJson: string; // must be valid JSON string
}>;

export type SystemMessage = Readonly<{
  role: "system";
  content: string;
}>;

export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

/**
 * Assistant message:
 * - content can be empty when toolCalls are present (common).
 */
export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string;
  toolCalls?: readonly ToolCall[];
}>;

/**
 * Tool result message (what your tool runner returns back into the conversation).
 * name should equal the tool call name; toolCallId links result to call.
 */
export type ToolMessage = Readonly<{
  role: "tool";
  name: string;
  toolCallId: string;
  content: string;
}>;

export type LlmMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

/**
 * JSON-schema-ish tool parameter typing (minimal but strict).
 * You can expand this later if needed; keep it provider-agnostic.
 */
export type JsonSchema =
  | Readonly<{
      type: "object";
      properties?: Record<string, JsonSchema>;
      required?: readonly string[];
      additionalProperties?: boolean;
    }>
  | Readonly<{ type: "array"; items: JsonSchema }>
  | Readonly<{ type: "string"; enum?: readonly string[] }>
  | Readonly<{ type: "number" }>
  | Readonly<{ type: "integer" }>
  | Readonly<{ type: "boolean" }>
  | Readonly<{ type: "null" }>;

/**
 * Tool definition supplied to the model.
 * This is the “contract” the model sees; actual implementation lives in tools/registry.ts
 */
export type ToolDefinition = Readonly<{
  name: string;
  description: string;
  parameters: JsonSchema; // JSON Schema (subset)
}>;

export type LlmRequest = Readonly<{
  provider: ProviderId;
  model?: string;

  messages: readonly LlmMessage[];

  /**
   * HARD CAP: provider adapters must enforce this.
   * This is the only internal knob; no provider-specific max_* fields elsewhere.
   */
  maxOutputTokens: number;

  /**
   * Optional sampling controls (provider adapters map what they can).
   * Keep optional to avoid accidentally changing behavior.
   */
  temperature?: number;
  topP?: number;

  /**
   * Tools supported by the model for this call.
   * If omitted or empty, provider should not enable tool calling.
   */
  tools?: readonly ToolDefinition[];

  /**
   * If you need deterministic runs, you can wire this later;
   * providers differ, so keep it optional.
   */
  seed?: number;

  /**
   * Free-form tags for logging/debugging.
   * Must not affect runtime behavior.
   */
  meta?: Readonly<{
    requestId?: string;
    traceId?: string;
    purpose?: string;
  }>;
}>;

export type LlmResponse = Readonly<{
  provider?: ProviderName;
  model?: string;

  /**
   * Convenience: the “main” assistant text (may be empty if toolCalls).
   * Always keep the full message as well.
   */
  text: string;

  /**
   * The assistant message produced by the model (canonical).
   */
  message: AssistantMessage;

  usage: Usage;
  finishReason: FinishReason;

  /**
   * Optional cost estimate if you compute it.
   */
  cost?: Cost;

  /**
   * Provider-specific response id if available (useful for debugging/support).
   */
  responseId?: string;
}>;

/**
 * Helper: create Usage safely without repeating totalTokens math everywhere.
 */
export function makeUsage(
  inputTokens: number,
  outputTokens: number,
  extra?: Omit<Usage, "inputTokens" | "outputTokens" | "totalTokens">,
): Usage {
  const safeIn = Number.isFinite(inputTokens)
    ? Math.max(0, Math.trunc(inputTokens))
    : 0;
  const safeOut = Number.isFinite(outputTokens)
    ? Math.max(0, Math.trunc(outputTokens))
    : 0;

  return {
    inputTokens: safeIn,
    outputTokens: safeOut,
    totalTokens: safeIn + safeOut,
    ...extra,
  };
}

/**
 * Helper: parse tool arguments JSON strictly.
 * (Keeps "any" out: unknown in, narrow later in each tool.)
 */
export function parseToolArguments(argumentsJson: string): unknown {
  // Let errors throw; toolloop can catch and handle uniformly.
  return JSON.parse(argumentsJson) as unknown;
}
