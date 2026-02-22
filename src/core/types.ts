export type ProviderName = "grok" | "anthropic";
export type Purpose = "default" | "dev" | "heartbeat";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmRequest = {
  purpose?: Purpose;
  messages: ChatMessage[];
  temperature?: number;
};

export type LlmResponse = {
  text: string;
  provider: ProviderName;
  model: string;
};
