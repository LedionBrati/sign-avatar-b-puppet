// The gear menu: card size (S / M / L), the server URL, "Always use the 3D signer".
import { setSettings, type Size } from "@/lib/settings";
import { always3d, form, gear, sizeSeg, urlIn } from "./dom";
import { applySize, fitStage } from "./frame";
import { checkHealth } from "./health";
import { resetCaptions, renderCaptions } from "./captions";
import { resetNeutral } from "./player";
import { reset3d } from "./signer3d";
import { s, setServer } from "./state";

const SIZES: Size[] = ["s", "m", "l"];

function setSize(size: Size) {
  if (size === s.size) return;
  s.size = size;
  setSettings({ size });
  applySize();
  resetCaptions(); renderCaptions();
}

const setForm = (open: boolean) => {
  form.hidden = !open;
  gear.setAttribute("aria-expanded", String(open));
  fitStage();
};
export function openServerForm() {
  setForm(true);
  urlIn.value = s.apiUrl;
  urlIn.focus();
  urlIn.select();
}

export function initMenu() {
  sizeSeg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-size]");
    if (b) setSize(b.dataset.size as Size);
  });
  sizeSeg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = SIZES.indexOf(s.size) + (e.key === "ArrowRight" ? 1 : -1);
    setSize(SIZES[Math.min(SIZES.length - 1, Math.max(0, i))]!);
    sizeSeg.querySelector<HTMLButtonElement>(`[data-size="${s.size}"]`)?.focus();
  });
  gear.addEventListener("click", () => (form.hidden ? openServerForm() : setForm(false)));
  always3d.checked = s.always3d;
  always3d.addEventListener("change", () => { s.always3d = always3d.checked; setSettings({ always3d: always3d.checked }); });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = urlIn.value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/\S+$/i.test(v)) { urlIn.setCustomValidity("http://host:port"); urlIn.reportValidity(); return; }
    urlIn.setCustomValidity("");
    setServer(v);
    resetNeutral();
    reset3d();
    setForm(false);
    checkHealth();
  });
}
