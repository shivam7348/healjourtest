import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Plus, RefreshCw, Trash2, UserPlus, X } from "lucide-react";
import DateTimeField from "./DateTimeField";
import FlabsBookingForm from "./FlabsBookingForm";
import PreBookingForm from "./PreBookingForm";

type Staff = { id: string; name: string; role: string; active: boolean };
type Appointment = {
  id: string; integratorID: string; leadId?: string; account: string; patientName: string; contact: string;
  tests: string[]; bookingType?: string; address?: string; scheduledAt?: string; staffId?: string;
  status: "unassigned" | "assigned" | "done" | "cancelled"; updatedAt: string;
};

const DAY_MS = 86_400_000;
const startOfWeek = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  return x;
};
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

/** Week calendar for bookings, with medical staff assignment. */
export function CalendarPage() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [newStaff, setNewStaff] = useState({ name: "", role: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/calendar");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Calendar could not load.");
      setStaff(data.staff);
      setAppointments(data.appointments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Calendar could not load.");
    }
  };
  useEffect(() => { void load(); }, []);

  const run = async (task: () => Promise<string>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); }
  };

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)), [weekStart]);
  const staffName = (id?: string) => staff.find(s => s.id === id)?.name ?? "";
  const unscheduled = appointments.filter(a => !a.scheduledAt && a.status !== "cancelled");
  const unassignedCount = appointments.filter(a => !a.staffId && a.status !== "cancelled" && a.status !== "done").length;

  const assign = (apt: Appointment, staffId: string) => run(async () => {
    const res = await fetch(`/api/appointments/${apt.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffId: staffId || null })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not assign.");
    return staffId ? `Assigned to ${staffName(staffId)}.` : "Unassigned.";
  });

  const setStatus = (apt: Appointment, status: Appointment["status"]) => run(async () => {
    const res = await fetch(`/api/appointments/${apt.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not update.");
    return status === "done" ? "Marked as done." : "Cancelled.";
  });

  const schedule = (apt: Appointment, value: string) => run(async () => {
    const res = await fetch(`/api/appointments/${apt.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledAt: value ? new Date(value).toISOString() : null })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not set the time.");
    return "Time saved.";
  });

  const addStaff = () => run(async () => {
    const res = await fetch("/api/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newStaff) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not add staff.");
    setNewStaff({ name: "", role: "" });
    return data.message;
  });

  const removeStaff = (s: Staff) => {
    if (!window.confirm(`Remove ${s.name}? Their bookings go back to unassigned.`)) return;
    void run(async () => {
      const res = await fetch(`/api/staff/${s.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove.");
      return data.message;
    });
  };

  const card = (a: Appointment) => <div key={a.id} className={`cal-card status-${a.status}`}>
    <div className="cal-card-top"><b>{a.scheduledAt ? timeOf(a.scheduledAt) : "No time"}</b><span>{a.patientName || "Patient"}</span></div>
    <small>{a.tests.join(", ") || "No tests"}</small>
    <small>{a.account}{a.bookingType ? ` · ${a.bookingType}` : ""}</small>
    <div className="cal-card-actions">
      <select value={a.staffId ?? ""} disabled={busy} onChange={e => void assign(a, e.target.value)} aria-label="Assign staff">
        <option value="">Unassigned</option>
        {staff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
      </select>
      {a.status !== "done" && a.status !== "cancelled" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void setStatus(a, "done")}><CheckCircle2 size={12} /> Done</Button>}
    </div>
    {!a.scheduledAt && <ScheduleField disabled={busy} onSave={value => void schedule(a, value)} />}
  </div>;

  return <div className="content core-page flabs-theme calendar-page">
    <div className="page-heading">
      <div><div className="eyebrow">ORDERS & BOOKINGS</div><h1>Calendar</h1><p>See each booking by day, and assign the medical staff who will handle it.</p></div>
      <div className="heading-actions"><Button variant="outline" onClick={() => void load()} disabled={busy}><RefreshCw size={15} /> Refresh</Button></div>
    </div>

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {notice && <div className="access-message success"><CheckCircle2 size={16} />{notice}<Button className="h-auto" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></div>}

    <div className="platform-stats">
      <div className="platform-stat"><small>Staff</small><b>{staff.length}</b><span>Available for assignment</span></div>
      <div className="platform-stat"><small>Unassigned</small><b>{unassignedCount}</b><span>Bookings still without staff</span></div>
      <div className="platform-stat"><small>Waiting for a time</small><b>{unscheduled.length}</b><span>Bookings with no appointment time</span></div>
    </div>

    <div className="calendar-layout">
      <aside className="calendar-side">
        <section className="access-card">
          <div className="access-card-head"><div><h2>Medical staff</h2><p>Add the people who handle bookings.</p></div></div>
          <div className="staff-add">
            <input placeholder="Name" value={newStaff.name} onChange={e => setNewStaff({ ...newStaff, name: e.target.value })} />
            <input placeholder="Role (e.g. Phlebotomist)" value={newStaff.role} onChange={e => setNewStaff({ ...newStaff, role: e.target.value })} />
            <Button variant="default" size="sm" disabled={busy || newStaff.name.trim().length < 2 || newStaff.role.trim().length < 2} onClick={() => void addStaff()}><UserPlus size={13} /> Add staff</Button>
          </div>
          {staff.length === 0 ? <p className="delivery-reason">No staff yet. Add someone above to start assigning.</p> :
            <ul className="staff-list">{staff.map(s => <li key={s.id}>
              <span><b>{s.name}</b><small>{s.role}</small></span>
              <span className="muted">{appointments.filter(a => a.staffId === s.id && a.status !== "cancelled").length} booked</span>
              <Button variant="ghost" className="h-auto icon-button-small" aria-label={`Remove ${s.name}`} onClick={() => removeStaff(s)}><Trash2 size={13} /></Button>
            </li>)}</ul>}
        </section>

        <section className="access-card">
          <div className="access-card-head"><div><h2>Waiting for a time</h2><p>Bookings without an appointment time.</p></div></div>
          {unscheduled.length === 0 ? <p className="delivery-reason">Nothing waiting.</p> :
            <div className="cal-stack">{unscheduled.map(card)}</div>}
        </section>
      </aside>

      <section className="calendar-main">
        <div className="calendar-nav">
          <Button variant="outline" size="sm" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))}><ChevronLeft size={14} /> Previous</Button>
          <Button variant="outline" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}><CalendarDays size={14} /> This week</Button>
          <Button variant="outline" size="sm" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))}>Next <ChevronRight size={14} /></Button>
          <b className="calendar-range">{days[0].toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} – {days[6].toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</b>
        </div>
        <div className="calendar-week">
          {days.map(day => {
            const dayItems = appointments
              .filter(a => a.scheduledAt && sameDay(new Date(a.scheduledAt), day) && a.status !== "cancelled")
              .sort((x, y) => (x.scheduledAt! < y.scheduledAt! ? -1 : 1));
            return <div key={day.toISOString()} className={`cal-day ${sameDay(day, new Date()) ? "is-today" : ""}`}>
              <div className="cal-day-head"><small>{day.toLocaleDateString("en-IN", { weekday: "short" })}</small><b>{day.getDate()}</b></div>
              {dayItems.length === 0 ? <p className="cal-empty">No bookings</p> : dayItems.map(card)}
            </div>;
          })}
        </div>
      </section>
    </div>
  </div>;
}

/** Picks a day and a 30-minute slot, then saves it only when the user confirms. */
function ScheduleField({ disabled, onSave }: { disabled: boolean; onSave: (value: string) => void }) {
  const [value, setValue] = useState("");
  return <div className="cal-time">
    <small>Set time</small>
    <DateTimeField value={value} onChange={setValue} disabled={disabled} />
    <Button variant="default" size="sm" disabled={disabled || !value} onClick={() => onSave(value)}><CalendarDays size={13} /> Save time</Button>
  </div>;
}

/** Orders & Bookings: create a booking or a pre-booking, or see the calendar. */
export function OrdersPage() {
  const [tab, setTab] = useState<"book" | "prebook" | "calendar">("book");
  return <>
    <div className="orders-tabs segmented">
      <Button variant="ghost" className={cn("h-auto", tab === "book" ? "selected" : "")} onClick={() => setTab("book")}><Plus size={13} /> New booking</Button>
      <Button variant="ghost" className={cn("h-auto", tab === "prebook" ? "selected" : "")} onClick={() => setTab("prebook")}><Plus size={13} /> Pre-booking</Button>
      <Button variant="ghost" className={cn("h-auto", tab === "calendar" ? "selected" : "")} onClick={() => setTab("calendar")}><CalendarDays size={13} /> Calendar</Button>
    </div>
    {tab === "book" ? <FlabsBookingForm /> : tab === "prebook" ? <PreBookingForm /> : <CalendarPage />}
  </>;
}
