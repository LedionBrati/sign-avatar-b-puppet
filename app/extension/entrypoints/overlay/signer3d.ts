// The instant 3D signer (app/core Signer3D on puppet/src/player.ts): one per server, loaded once, kept warm.
import { ROUTES, Signer3D } from "@flux/core";
import { layer3d, stage } from "./dom";
import { client } from "./state";

let signer3d: Signer3D | null = null;

export function get3d(): Signer3D {
  if (!signer3d || !signer3d.canvas.isConnected) {
    signer3d?.stop();
    layer3d.replaceChildren();
    const canvas = document.createElement("canvas");
    canvas.width = 540;
    canvas.height = 720;
    layer3d.appendChild(canvas);
    signer3d = new Signer3D({ load: () => import("@flux/signer-player"), modelUrl: client.modelUrl(), canvas });
  }
  return signer3d;
}

/** Stop the current phrase (if any). */
export const stop3d = () => signer3d?.stop();

/** The server changed: the next phrase loads a new signer. */
export function reset3d() {
  signer3d?.stop();
  signer3d = null;
  layer3d.replaceChildren();
  setMode("clips");
}

/** The rest pose a 3D phrase starts and ends in. */
export const restUrl = () => `${client.base}${ROUTES.motion}neutral.json`;

/** Which signer is on stage (the 3D canvas fades in over the clips). */
export function setMode(m: "clips" | "3d") { if (stage.dataset.mode !== m) stage.dataset.mode = m; }
