import { Button } from "@/components/ui/button";
import { useMemo } from "react";

/**
 * Date and time picker that is easier than the browser's built-in one: a calendar for the day,
 * a list of 30-minute time slots, and quick buttons. The value is "YYYY-MM-DDTHH:mm" (local time),
 * or "" when nothing is chosen.
 */
const SLOT_START_HOUR = 6;
const SLOT_END_HOUR = 21;

const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function slots() {
  const out: string[] = [];
  for (let h = SLOT_START_HOUR; h <= SLOT_END_HOUR; h++) {
    out.push(`${pad(h)}:00`, `${pad(h)}:30`);
  }
  return out;
}

const formatTime = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${pad(m)} ${suffix}`;
};

export default function DateTimeField({ value, onChange, disabled }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [date, time] = value ? value.split("T") : ["", ""];
  const today = useMemo(() => toDateInput(new Date()), []);
  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return toDateInput(d);
  }, []);
  const timeSlots = useMemo(slots, []);

  const setDate = (d: string) => onChange(d ? `${d}T${time || "09:00"}` : "");
  const setTime = (t: string) => onChange(date ? `${date || today}T${t}` : "");

  return <div className="dt-field">
    <div className="dt-row">
      <input type="date" className="dt-date" value={date} min={today} disabled={disabled} onChange={e => setDate(e.target.value)} aria-label="Date" />
      <select className="dt-time" value={time} disabled={disabled || !date} onChange={e => setTime(e.target.value)} aria-label="Time">
        <option value="">{date ? "Choose time" : "Choose a date first"}</option>
        {timeSlots.map(t => <option key={t} value={t}>{formatTime(t)}</option>)}
      </select>
    </div>
    <div className="dt-quick">
      <Button variant="ghost" type="button" className="h-auto dt-chip" disabled={disabled} onClick={() => setDate(today)}>Today</Button>
      <Button variant="ghost" type="button" className="h-auto dt-chip" disabled={disabled} onClick={() => setDate(tomorrow)}>Tomorrow</Button>
      {value && <Button variant="ghost" type="button" className="h-auto dt-chip dt-clear" disabled={disabled} onClick={() => onChange("")}>Clear</Button>}
      {value && <span className="dt-summary">{new Date(value).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" })}{time ? `, ${formatTime(time)}` : ""}</span>}
    </div>
  </div>;
}
