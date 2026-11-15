// Motion helpers: View Transitions for screen changes (skipped under prefers-reduced-motion).
import { flushSync } from "react-dom";

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type VTDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

/** Run a state change inside a view transition when the browser has one; otherwise just run it. */
export function transition(fn: () => void) {
  const d = document as VTDoc;
  if (!d.startViewTransition || reducedMotion() || document.visibilityState !== "visible") { fn(); return; }
  d.startViewTransition(() => flushSync(fn));
}
