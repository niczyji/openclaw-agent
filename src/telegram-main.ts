import "dotenv/config";
import { startTelegramAdapter } from "./adapters/telegram";

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

  await startTelegramAdapter({ token });
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
