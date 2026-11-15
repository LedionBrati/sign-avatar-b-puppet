import "@/lib/base.css";
import { browser } from "wxt/browser";
import type { HealthResult } from "@/lib/messages";
import { getSettings, setSettings } from "@/lib/settings";
import { $, esc, MARK, WORDMARK } from "@/lib/brand";

$("brand").innerHTML = `<span style="display:inline-flex;gap:8px;align-items:center">${MARK}${WORDMARK}</span>`;
const input = $("url") as HTMLInputElement;
input.value = (await getSettings()).apiUrl;
$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  await setSettings({ apiUrl: input.value.trim().replace(/\/$/, "") });
  const h = (await browser.runtime.sendMessage({ type: "health" })) as HealthResult;
  $("st").textContent = h.ok ? `Saved. Connected: ${h.signs} signs.` : `Saved, but can't reach ${h.url} (${h.error}).`;
  void esc;
});
