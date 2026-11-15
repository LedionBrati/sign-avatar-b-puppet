import "./style.css";
import { browser } from "wxt/browser";
import type { ToBackground } from "@/lib/messages";
import { setSettings } from "@/lib/settings";
import { $, esc, MARK, WORDMARK } from "@/lib/brand";

// Microphone source: Web Speech API runs here (an extension page), final phrases go to the active tab's signer.
// Side panels can't show the permission prompt, so the first time we open mic.html in a tab to grant it.

$("brand").innerHTML = MARK + WORDMARK;
type Rec = {
  continuous: boolean; interimResults: boolean; lang: string;
  start(): void; stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
const Ctor = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;

const listenBtn = $("listen"), listenText = $("listenText"), status = $("status"), live = $("live"), liveText = $("liveText");
let rec: Rec | null = null;
let wanted = false;
const send = (m: ToBackground) => browser.runtime.sendMessage(m).catch(() => {});

function setListening(on: boolean) {
  listenBtn.setAttribute("aria-pressed", String(on));
  listenText.textContent = on ? "Listening… tap to stop" : "Tap to listen";
  live.classList.toggle("off", !on);
  liveText.textContent = on ? "Listening" : "Ready";
}

function start() {
  if (!Ctor) {
    status.textContent = "Speech recognition isn't available in this browser.";
    return;
  }
  wanted = true;
  setSettings({ source: "mic", enabled: true });
  rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      const text = r[0].transcript.trim();
      if (!text) continue;
      if (r.isFinal) {
        $("finals").insertAdjacentHTML("beforeend", `<li>${esc(text)}</li>`);
        send({ type: "sign", text, source: "mic", target: "active" });
      } else interim += `${text} `;
    }
    $("interim").textContent = interim;
    if (interim) send({ type: "heard", text: interim.trim(), source: "mic", target: "active" });
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      wanted = false;
      status.textContent = "SIGNLAYER needs microphone access once.";
      $("enable").hidden = false;
    } else if (e.error !== "no-speech" && e.error !== "aborted") status.textContent = `Speech recognition: ${e.error}`;
  };
  rec.onend = () => {
    // Chrome ends recognition after silence; keep going while the user wants it on.
    if (wanted) {
      try {
        rec?.start();
        return;
      } catch {
        /* fall through */
      }
    }
    setListening(false);
  };
  try {
    rec.start();
    status.textContent = "";
    $("enable").hidden = true;
    setListening(true);
  } catch (err) {
    status.textContent = String(err);
  }
}

function stop() {
  wanted = false;
  rec?.stop();
  setListening(false);
}

listenBtn.addEventListener("click", () => (wanted ? stop() : start()));
$("enable").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("/mic.html") }));
