import OpenAI from "openai";
import { config } from "../config.js";
import type { LlmRequest, LlmResponse } from "../core/types.js";

const client = new OpenAI({
  apiKey: config.grok.apiKey,
  baseURL: config.grok.baseURL,
});

export async function grokChat(req: LlmRequest): Promise<LlmResponse> {
  const res = await client.chat.completions.create({
    model: config.grok.model,
    messages: req.messages,
    temperature: req.temperature,
  });

  const text = res.choices[0]?.message?.content ?? "(no response)";
  return { text, provider: "grok", model: config.grok.model };
}
