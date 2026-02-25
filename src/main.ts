// src/main.ts
import { main as cliMain } from "./adapters/cli.js";
import { startTelegramAdapter } from "./adapters/telegram.js";

async function boot() {
  const token = (process.env.TELEGRAM_TOKEN ?? "").trim();

  if (token) {
    await startTelegramAdapter({ token });
    return;
  }

  await cliMain(process.argv.slice(2));
}

boot().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
