// Sign -> speak numbers for scripts/sign-test.mjs, which reads window.__sl (delegate, fps, detectMs, and per segment:
// last, frames, segMs, reason, rtMs). Nothing in the app reads them.
declare global { interface Window { __sl?: Record<string, unknown> } }

export function debugStats(patch: Record<string, unknown>) {
  window.__sl = { ...window.__sl, ...patch };
}
