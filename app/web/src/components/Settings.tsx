import { useState } from "react";
import { createSignClient } from "@signlayer/core";
import { ENV_API, apiBase, getApiSetting, setApiSetting } from "../config";

export function Settings({ onClose }: { onClose(): void }) {
  const [url, setUrl] = useState(getApiSetting());
  const [status, setStatus] = useState("");
  async function test() {
    const base = url.trim() ? url.trim().replace(/\/$/, "") : apiBase();
    setStatus("Checking…");
    try {
      const h = await createSignClient(base === "same-origin" ? "" : base, { timeoutMs: 4000 }).health();
      setStatus(`Connected · ${h.signs} signs`);
    } catch (e) {
      setStatus(`Can't reach it (${(e as Error).message})`);
    }
  }
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p>Where the sign server runs. On a phone, use your computer's LAN address, e.g. http://192.168.1.20:8787.</p>
        <label htmlFor="api">Server URL</label>
        <input id="api" inputMode="url" autoComplete="off" spellCheck={false} placeholder={ENV_API} value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="row">
          <span className="status" aria-live="polite">{status}</span>
          <button className="btn" type="button" onClick={test}>Test</button>
          <button className="btn primary" type="button" onClick={() => { setApiSetting(url); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
