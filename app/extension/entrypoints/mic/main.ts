import "@/lib/base.css";
import { $, MARK, WORDMARK } from "@/lib/brand";

// One-time permission page: side panels can't show Chrome's permission prompt, a normal extension tab can.
$("brand").innerHTML = `<span style="display:inline-flex;gap:8px;align-items:center">${MARK}${WORDMARK}</span>`;
const msg = $("msg");

$("go").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    msg.innerHTML = `<span class="ok">Microphone enabled.</span> Go back to the side panel and tap <b>Tap to listen</b>. You can close this tab.`;
    setTimeout(() => window.close(), 2500);
  } catch (e) {
    msg.innerHTML = `<span class="bad">Not allowed (${e instanceof Error ? e.name : e}).</span> Click the icon at the right of the address bar to allow the microphone, then try again.`;
  }
});
