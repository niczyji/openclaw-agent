// scripts/e2e-claude.ts
import { runToolLoop } from "../src/core/toolloop";
import type { LlmMessage } from "../src/core/types";
import { ALL_TOOLS } from "../src/tools/definitions";

async function main() {
  const messages: LlmMessage[] = [
    { role: "system", content: "You are a tool-using coding assistant." },
    {
      role: "user",
      content:
        "Do these steps strictly:\n" +
        '1) list_dir {"path":"notes"}\n' +
        '2) read_file {"path":"notes/test.txt"}\n' +
        '3) write_file {"path":"data/outputs/summary.md","content":"<summary here>","overwrite":true}\n' +
        "Then confirm you wrote the file.",
    },
  ];

  const result = await runToolLoop({
    request: {
      provider: "anthropic",
      // model optional if your router/provider defaults it; otherwise set it:
      model: "claude-sonnet-4-6", // or whatever you have in config
      messages,
      maxOutputTokens: 600,
      temperature: 0.2,
      tools: ALL_TOOLS,
    },
    limits: { maxSteps: 6, maxToolCalls: 6 },
    keepLastN: 30,
    approve: async (call) => {
      // For the test, approve everything (safe because policy restricts paths)
      console.log("\nAPPROVE TOOL:", call.name, call.argumentsJson);
      return true;
    },
  });

  console.log("\n=== FINAL TEXT ===\n", result.final.text);
  console.log("\n=== USAGE TOTAL ===\n", result.usageTotal);
  console.log("\n=== WROTE FILE? ===");
  console.log("Check: data/outputs/summary.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
