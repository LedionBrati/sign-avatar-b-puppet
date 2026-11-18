// The card's elements (index.html), the brand marks and the voice wave.
import { $, ICON, mark, WORDMARK } from "@/lib/brand";
import { createWave } from "@/lib/wave";

export const card = $("card"), stageWrap = $("stageWrap");
export const stage = $("stage"), cc = $("cc"), note = $("note");
export const statusEl = $("pill"), dot = $("dot");
export const go = $("go"), seg = $("seg"), sizeSeg = $("size"), gear = $("gear"), closeBtn = $("close"), grip = $("grip");
export const form = $("server") as HTMLFormElement, urlIn = $("apiUrl") as HTMLInputElement, always3d = $("always3d") as HTMLInputElement;
export const vids = [$("v0") as HTMLVideoElement, $("v1") as HTMLVideoElement];
export const still = $("still") as HTMLCanvasElement;
export const layer3d = $("s3d");
$("brand").innerHTML = mark() + WORDMARK;
gear.innerHTML = ICON.gear;
closeBtn.innerHTML = ICON.close;
export const wave = createWave($("wv") as HTMLCanvasElement);
