// core/router.ts
import type { LlmRequest, LlmResponse } from "./types.js";
import { grokChat } from "../providers/grok.js";
import { anthropicChat } from "../providers/anthropic.js";

export async function chat(req: LlmRequest): Promise<LlmResponse> {
  switch (req.provider) {
    case "grok":
      return grokChat(req);

    case "anthropic":
      return anthropicChat(req);

    default: {
      // Exhaustiveness check
      const neverProvider: never = req.provider;
      throw new Error(`Unsupported provider: ${neverProvider}`);
    }
  }
}
