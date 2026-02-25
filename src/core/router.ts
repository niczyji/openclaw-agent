// core/router.ts
import type { LlmRequest, LlmResponse, ProviderName } from "./types.js";
import { grokChat } from "../providers/grok.js";
import { anthropicChat } from "../providers/anthropic.js";

function resolveProvider(req: LlmRequest): ProviderName {
  // Explicit override
  if (req.provider) return req.provider;

  // Purpose-based default
  if (req.purpose === "dev") return "anthropic";
  return "grok";
}

function resolveModel(req: LlmRequest, provider: ProviderName): string {
  // Explicit override
  if (req.model && req.model.trim()) return req.model;

  // Provider defaults (you can later move these to config)
  return provider === "anthropic" ? "claude-sonnet-4-6" : "grok-3-mini";
}

export async function chat(req: LlmRequest): Promise<LlmResponse> {
  const provider = resolveProvider(req);
  const model = resolveModel(req, provider);

  const finalReq: LlmRequest = { ...req, provider, model };

  switch (provider) {
    case "grok":
      return grokChat(finalReq);
    case "anthropic":
      return anthropicChat(finalReq);
    default: {
      const neverProvider: never = provider;
      throw new Error(`Unsupported provider: ${neverProvider}`);
    }
  }
}
