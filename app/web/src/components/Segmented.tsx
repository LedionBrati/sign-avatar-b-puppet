// iOS-style segmented control: the thumb springs to the chosen option.
import { useLayoutEffect, useRef } from "react";

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const b = box.current, t = thumb.current;
    const on = b?.querySelector<HTMLElement>("button.on");
    if (!b || !t || !on) return;
    t.style.width = `${on.offsetWidth}px`;
    t.style.transform = `translateX(${on.offsetLeft - 3}px)`;
  }, [value, options]);
  return (
    <div className="seg" role="radiogroup" aria-label={label} ref={box}>
      <span className="thumb" ref={thumb} aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
