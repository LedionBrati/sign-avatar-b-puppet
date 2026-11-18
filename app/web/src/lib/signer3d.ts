// The page's one 3D signer (app/core Signer3D on puppet/src/player.ts): created on first use, kept warm for the rest of
// the session (the canvas moves between screens; the player bundle and signer.glb load once).
import { ROUTES, Signer3D } from "@flux/core";
import { ARTIFACT, apiBase } from "../config";

let inst: Signer3D | null = null;
let base: string | null = null;

/** The 3D signer for the current server (a new one if the server URL changed in Settings). */
export function getSigner3D(): Signer3D {
  const b = apiBase();
  if (!inst || b !== base) {
    inst?.stop();
    base = b;
    const canvas = document.createElement("canvas");
    canvas.width = 540;
    canvas.height = 720;
    canvas.className = "sl-3d-canvas";
    canvas.setAttribute("aria-hidden", "true");
    inst = new Signer3D({
      // The standalone artifact build has no 3D signer (no server for the avatar and motions).
      load: ARTIFACT ? () => Promise.reject(new Error("no 3D signer in the artifact build")) : () => import("@flux/signer-player"),
      modelUrl: `${b}${ROUTES.model}`,
      canvas,
    });
  }
  return inst;
}

/** The rest pose a 3D phrase starts and ends in. */
export const restMotionUrl = () => `${apiBase()}${ROUTES.motion}neutral.json`;
