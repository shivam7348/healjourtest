import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export type PickerOption = { value: string; label: string; hint?: string };

/**
 * A styled dropdown: a field-like button that opens a floating list (selected item highlighted).
 * Keyboard: Enter/Space/ArrowDown opens, arrows move, Enter picks, Escape closes.
 */
export default function Picker({ value, options, onChange, placeholder = "Select", disabled, ariaLabel, className }: {
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const show = () => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    setOpen(true);
  };
  const pick = (o: PickerOption) => { onChange(o.value); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown"].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (options[active]) pick(options[active]); }
  };

  return <div ref={root} className={`pk${open ? " open" : ""}${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`}>
    <button type="button" className="pk-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} disabled={disabled}
      onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}>
      <span className={current ? "pk-value" : "pk-placeholder"}>{current?.label ?? placeholder}</span>
      <ChevronDown size={16} className="pk-chev" />
    </button>
    {open && <ul className="pk-list" role="listbox">
      {options.map((o, i) => <li key={o.value} role="option" aria-selected={o.value === value}
        className={`${o.value === value ? "on" : ""}${i === active ? " active" : ""}`}
        onMouseEnter={() => setActive(i)} onMouseDown={e => { e.preventDefault(); pick(o); }}>
        <span>{o.label}{o.hint && <small>{o.hint}</small>}</span>
        {o.value === value && <Check size={15} />}
      </li>)}
      {options.length === 0 && <li className="pk-empty">No options yet</li>}
    </ul>}
  </div>;
}
