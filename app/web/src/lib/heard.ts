// The last thing the hearing person said (Live screen, speech -> sign), kept for 2 minutes in sessionStorage so the
// sign -> voice screen can give the sentence model the conversation's context. Best effort: storage may be blocked.
const KEY = "sl-heard";
const MAX_AGE_MS = 120_000;

export function saveHeard(text: string) {
  const t = text.replace(/\s+/g, " ").trim().slice(-300);
  if (!t) return;
  try { sessionStorage.setItem(KEY, JSON.stringify({ text: t, at: Date.now() })); } catch { /* private mode / blocked */ }
}

export function readHeard(): string | undefined {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "null") as { text?: unknown; at?: unknown } | null;
    if (v && typeof v.text === "string" && typeof v.at === "number" && Date.now() - v.at < MAX_AGE_MS) return v.text;
  } catch { /* blocked or corrupt */ }
  return undefined;
}
