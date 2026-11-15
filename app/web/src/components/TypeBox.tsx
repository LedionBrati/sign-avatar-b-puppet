import { useState } from "react";

export function TypeBox({ onSubmit, placeholder = "Type to sign", autoFocus, busy }: { onSubmit(text: string): void; placeholder?: string; autoFocus?: boolean; busy?: boolean }) {
  const [text, setText] = useState("");
  return (
    <form className="typebox" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t) { onSubmit(t); setText(""); } }}>
      <input aria-label="Text to sign" placeholder={placeholder} value={text} autoFocus={autoFocus} enterKeyHint="send"
        autoComplete="off" onChange={(e) => setText(e.target.value)} />
      <button type="submit" disabled={!text.trim() || busy}>Sign</button>
    </form>
  );
}
