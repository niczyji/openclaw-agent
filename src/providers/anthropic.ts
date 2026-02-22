import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { LlmRequest, LlmResponse, ChatMessage } from "../core/types.js";

const client = new Anthropic({
  apiKey: config.anthropic.apiKey ?? "",
});

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  msgs: { role: "user" | "assistant"; content: string }[];
} {
  const systemParts: string[] = [];
  const msgs: { role: "user" | "assistant"; content: string }[] = [];

  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else if (m.role === "user") msgs.push({ role: "user", content: m.content });
    else msgs.push({ role: "assistant", content: m.content });
  }

  const system = systemParts.length ? systemParts.join("\n\n") : undefined;
  return { system, msgs };
}

export async function anthropicChat(req: LlmRequest): Promise<LlmResponse> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set. Set it in .env to enable Anthropic.");
  }

  const { system, msgs } = toAnthropicMessages(req.messages);

  const res = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 600,
    temperature: req.temperature ?? 0.2,
    system,
    messages: msgs.length ? msgs : [{ role: "user", content: "Hello" }],
  });

  // Anthropic liefert content als Array (Text-Blöcke etc.)
  const text =
    res.content
      .filter((c) => c.type === "text")
      .map((c: any) => c.text)
      .join("") || "(no response)";

  return { text, provider: "anthropic", model: config.anthropic.model };
}
