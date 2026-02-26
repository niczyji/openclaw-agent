import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/telegram-main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: "dist",
  dts: false, // <-- wichtig: kein d.ts build (der typcheckt)
  external: ["openai", "@anthropic-ai/sdk"],
});
