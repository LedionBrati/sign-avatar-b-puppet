import "@/lib/fonts";
import "./style.css";
import "./dom";
import { renderControls, initControls } from "./controls";
import { applySize, initFrame } from "./frame";
import { checkHealth, initHealth } from "./health";
import { initListen, startListening } from "./listen";
import { initMenu } from "./menu";
import { initPhrases } from "./phrases";
import { initPlayer } from "./player";
import { initStatus, render } from "./status";
import { params, s } from "./state";

// The floating card is the whole product (this page runs in an iframe inside the page's glass frame, float.ts):
//   Mic or Tab audio, captured and transcribed in the offscreen document ─► text messages here (listen.ts)
//   ─► phrases ─► POST /api/sign (phrases.ts: in parallel; applied in order; overtaken live results skipped)
//   ─► playlist ─► player.ts: two stacked <video>s (the next clip preloads in the hidden one and crossfades in on its
//      first painted frame), or the whole phrase on the 3D signer (signer3d.ts) ─► captions.ts follows the signing.
// The rest: frame.ts (size, drag grip, messages with float.ts), controls.ts (Mic | Tab, Start), menu.ts (gear menu:
// size, server, 3D), status.ts (status dot, problem line), health.ts (server checks), state.ts, dom.ts.
// Like the web app's Live card: a phrase that can't be signed (the safety gate says caption_only / needs_confirmation)
// isn't played. No popup, no hint: the signer just stays still and the transcript still shows the words.

initFrame();
initMenu();
initControls();
initListen();
initStatus();
initPlayer();
initPhrases();
initHealth();

applySize();
renderControls();
render();
checkHealth();
// Opened by a toolbar click while Tab audio was running on another tab: listening moves here.
if (params.get("autostart") === "tab") { s.source = "tab"; renderControls(); startListening(); }
