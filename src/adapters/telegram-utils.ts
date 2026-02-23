// src/adapters/telegram-utils.ts
const TG_MAX = 4096;
const CHUNK = 3500;

export async function sendLongMessage(
  bot: any,
  chatId: number | string,
  text: string,
  extra?: any,
) {
  if (!text) return null;

  if (text.length <= TG_MAX) {
    return await bot.sendMessage(chatId, text, extra);
  }

  const extraNoParse = extra ? { ...extra } : undefined;
  if (extraNoParse && "parse_mode" in extraNoParse)
    delete (extraNoParse as any).parse_mode;

  let lastMsg: any = null;
  for (let i = 0; i < text.length; i += CHUNK) {
    lastMsg = await bot.sendMessage(
      chatId,
      text.slice(i, i + CHUNK),
      extraNoParse,
    );
  }
  return lastMsg;
}
