export function parseIdSet(env: string | undefined): Set<string> {
  return new Set(
    (env ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isAdminChat(chatId: string | number): boolean {
  const admins = parseIdSet(process.env.TELEGRAM_ADMIN_CHAT_IDS);
  return admins.has(String(chatId));
}
