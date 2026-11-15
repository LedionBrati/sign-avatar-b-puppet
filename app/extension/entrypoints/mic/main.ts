import "@/lib/fonts";
import "@/lib/base.css";
import { browser } from "wxt/browser";
import { $, mark, WORDMARK } from "@/lib/brand";

// One-time permission tab: the card (an iframe) and the offscreen document can't show Chrome's permission prompt; a normal extension tab can.
// Asks at once, tells the card, closes itself (Chrome returns to the tab that opened it).
$("brand").innerHTML = mark() + WORDMARK;
const msg = $("msg"), btn = $("go");

async function ask() {
  btn.hidden = true;
  msg.textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    msg.innerHTML = `<span class="ok">Microphone allowed.</span> Back to the card…`;
    await browser.runtime.sendMessage({ type: "mic-granted" }).catch(() => {});
    setTimeout(async () => {
      const t = await browser.tabs.getCurrent().catch(() => undefined);
      if (t?.id != null) browser.tabs.remove(t.id).catch(() => window.close());
      else window.close();
    }, 900);
  } catch (e) {
    msg.innerHTML = `<span class="bad">Not allowed (${e instanceof Error ? e.name : e}).</span> Click the icon at the right of the address bar to allow the microphone, then try again.`;
    btn.hidden = false;
  }
}
btn.addEventListener("click", ask);
ask();
