import type { Purpose, ChatMessage } from "./types.js";
import { chat } from "./router.js";
import type { Session } from "../memory/store.js";

export type RunOptions = {
  purpose: Purpose;
  input: string;
  system?: string;
  keepLastN?: number; // context limit
};

export async function runAgent(session: Session, opts: RunOptions) {
  const systemMsg: ChatMessage = {
    role: "system",
    content:
      opts.system ?? "You are a helpful assistant. Keep answers concise unless asked otherwise.",
  };

  // context: system + previous msgs + new user msg
  const keep = opts.keepLastN ?? 20;
  const history = session.messages.slice(-keep);

  const messages: ChatMessage[] = [systemMsg, ...history, { role: "user", content: opts.input }];
  const temp = opts.purpose === "dev" ? 0.5 : 0.2;

  const res = await chat({
    purpose: opts.purpose,
    messages,
    temperature: temp,
  });

  // persist turn
  session.messages.push({ role: "user", content: opts.input });
  session.messages.push({ role: "assistant", content: res.text });

  return res;
}
