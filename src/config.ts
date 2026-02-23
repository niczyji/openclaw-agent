import "dotenv/config";
import type { ProviderName } from "./core/types.js";

function env(name: string): string | undefined {
  return process.env[name];
}
function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required env variable: ${name}`);
  return v;
}

export const config = {
  providers: {
    default: "grok" as ProviderName,
    dev: "anthropic" as ProviderName,
  },

  grok: {
    apiKey: requireEnv("GROK_API_KEY"),
    model: env("GROK_MODEL") ?? "grok-3-mini",
    baseUrl: env("GROK_BASE_URL") ?? "https://api.x.ai/v1", // <- change name
  },
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY") ?? null,
    model: env("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-latest",
  },
};
