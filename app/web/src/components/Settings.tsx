// Settings as a clean sheet: appearance, captions, and where the sign server runs.
import { useState } from "react";
import { copy, createSignClient } from "@signlayer/core";
import { ARTIFACT, ENV_API, apiBase, getApiSetting, setApiSetting } from "../config";
import { setPrefs, usePrefs, type Theme } from "../lib/prefs";
import { Segmented } from "./Segmented";

export function Settings({ onClose }: { onClose(): void }) {
  const prefs = usePrefs();
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
  const done = () => { if (url.trim() !== getApiSetting()) setApiSetting(url); onClose(); };
  return (
    <div className="sheet-back" onClick={done}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); done(); } }}>
        <div className="grabber" aria-hidden="true" />
        <header className="sheet-head">
          <h2>Settings</h2>
          <button className="textbtn" type="button" onClick={done} autoFocus>Done</button>
        </header>

        <p className="group-label">Display</p>
        <div className="group">
          <div className="row">
            <span>Appearance</span>
            <Segmented<Theme> label="Appearance" value={prefs.theme === "light" ? "light" : "dark"} onChange={(theme: Theme) => setPrefs({ theme })}
              options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
          </div>
          <div className="row">
            <span id="cap-l">Captions</span>
            <button type="button" className="switch" role="switch" aria-labelledby="cap-l" aria-checked={prefs.captions} onClick={() => setPrefs({ captions: !prefs.captions })} />
          </div>
        </div>

        {ARTIFACT ? null : (<>
        <p className="group-label"><label htmlFor="api">Sign server</label></p>
        <div className="group">
          <div className="row">
            <input id="api" inputMode="url" autoComplete="off" spellCheck={false} placeholder={ENV_API} value={url} onChange={(e) => { setUrl(e.target.value); setStatus(""); }} />
          </div>
          <div className="row">
            <span className="status" aria-live="polite">{status || "On a phone, use your computer's LAN address."}</span>
            <button className="btn" type="button" onClick={test}>Test</button>
          </div>
        </div>
        </>)}
        <p className="footnote">{copy.credit}</p>
      </div>
    </div>
  );
}
