// The whole conversation of this session, both directions: what the hearing person said (Live, speech -> sign: "them")
// and what the signer said (sign -> voice: "me"). Kept in sessionStorage (last 20 turns) so the sentence model gets
// the conversation, not just one line. Best effort: storage may be blocked (private mode), then it lives in memory.
export interface Turn { who: "them" | "me"; text: string; at: number }

const KEY = "sl-chat";
export const CHAT_MAX = 20;
let mem: Turn[] = [];

export function readChat(): Turn[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "null") as unknown;
    if (Array.isArray(v)) {
      mem = v.filter((x): x is Turn => !!x && (x.who === "them" || x.who === "me") && typeof x.text === "string" && typeof x.at === "number").slice(-CHAT_MAX);
    }
  } catch { /* blocked or corrupt: keep the in-memory copy */ }
  return mem;
}

/** Append one turn. An exact repeat of the previous turn (same side, same text) is not added again. */
export function addTurn(who: Turn["who"], text: string) {
  const t = text.replace(/\s+/g, " ").trim().slice(-300);
  if (!t) return;
  const turns = readChat();
  const prev = turns[turns.length - 1];
  if (prev && prev.who === who && prev.text === t) return;
  mem = [...turns, { who, text: t, at: Date.now() }].slice(-CHAT_MAX);
  try { sessionStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* private mode / blocked */ }
}

/** The last `n` turns, oldest first, as ComposeRequest.context.history. */
export function recentHistory(n = 10): { who: Turn["who"]; text: string }[] {
  return readChat().slice(-n).map(({ who, text }) => ({ who, text }));
}
