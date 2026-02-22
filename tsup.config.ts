import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/telegram-main.ts"],
  format: ["esm"],
  target: "node20", // läuft auch auf node24; node20 als “stable baseline”
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: "dist",
  // Damit du node_modules nicht komplett reinbundlest (schnellere builds)
  external: ["openai", "@anthropic-ai/sdk"],
});
