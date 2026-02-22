import { config } from "../config.js";
import type { LlmRequest, LlmResponse, ProviderName } from "./types.js";
import { grokChat } from "../providers/grok.js";
import { anthropicChat } from "../providers/anthropic.js";

function resolveProvider(purpose: LlmRequest["purpose"]): ProviderName {
  if (purpose === "dev") return config.providers.dev;
  return config.providers.default; // default + heartbeat -> grok
}

export async function chat(req: LlmRequest): Promise<LlmResponse> {
  const provider = resolveProvider(req.purpose);

  if (provider === "grok") return grokChat(req);
  if (provider === "anthropic") return anthropicChat(req);

  throw new Error(`Unknown provider resolved: ${provider}`);
}
