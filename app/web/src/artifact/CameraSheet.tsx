// Artifact build only: Sign -> speak needs the camera, which the artifact sandbox refuses. A calm sheet says so.
import { HandIcon } from "../components/Icons";

export function CameraSheet({ onClose }: { onClose(): void }) {
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Sign to speak" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <div className="grabber" aria-hidden="true" />
        <header className="sheet-head">
          <h2>Sign to speak</h2>
          <button className="textbtn" type="button" onClick={onClose} autoFocus>Done</button>
        </header>
        <div className="camnote">
          <span className="camnote-icon" aria-hidden="true"><HandIcon /></span>
          <p>Sign to speak needs the camera — try it in the full app.</p>
        </div>
      </div>
    </div>
  );
}
