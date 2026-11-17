import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Download, Plus, RefreshCw, Settings2, Trash2, UserPlus, X } from "lucide-react";
import FlabsTracker from "./FlabsTracker";
import BookingFormSettings from "./BookingFormSettings";
import FlabsResults from "./FlabsResults";
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
  // Phones start in the list view; a 7-column week does not fit a narrow screen.
  const [view, setView] = useState<"week" | "list">(() => (typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches ? "list" : "week"));

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

  const STATUS_TEXT: Record<Appointment["status"], string> = { unassigned: "Unassigned", assigned: "Assigned", done: "Done", cancelled: "Cancelled" };
  const itemsFor = (day: Date) => appointments
    .filter(a => a.scheduledAt && sameDay(new Date(a.scheduledAt), day) && a.status !== "cancelled")
    .sort((x, y) => (x.scheduledAt! < y.scheduledAt! ? -1 : 1));
  const weekCount = days.reduce((n, d) => n + itemsFor(d).length, 0);
  const today = new Date();

  const card = (a: Appointment) => <article key={a.id} className={`cal2-card s-${a.status}`}>
    <div className="cal2-card-top">
      <span className="cal2-time">{a.scheduledAt ? timeOf(a.scheduledAt) : "No time"}</span>
      <span className={`cal2-badge s-${a.status}`}>{STATUS_TEXT[a.status]}</span>
    </div>
    <b className="cal2-patient">{a.patientName || "Patient"}</b>
    <small className="cal2-tests" title={a.tests.join(", ")}>{a.tests.join(", ") || "No tests"}</small>
    <small className="cal2-meta">{a.account}{a.bookingType ? ` · ${a.bookingType}` : ""}</small>
    <div className="cal2-actions">
      <select value={a.staffId ?? ""} disabled={busy} onChange={e => void assign(a, e.target.value)} aria-label="Assign staff">
        <option value="">Assign staff…</option>
        {staff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
      </select>
      {a.status !== "done" && a.status !== "cancelled" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void setStatus(a, "done")} aria-label="Mark done"><CheckCircle2 size={13} /></Button>}
    </div>
    {!a.scheduledAt && <ScheduleField disabled={busy} onSave={value => void schedule(a, value)} />}
  </article>;

  return <div className="content core-page flabs-theme calendar-page">
    <div className="page-heading">
      <div><div className="eyebrow">ORDERS & BOOKINGS</div><h1>Calendar</h1><p>See each booking by day, and assign the medical staff who will handle it.</p></div>
      <div className="heading-actions"><Button variant="outline" onClick={() => void load()} disabled={busy}><RefreshCw size={15} /> Refresh</Button></div>
    </div>

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {notice && <div className="access-message success"><CheckCircle2 size={16} />{notice}<Button className="h-auto" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></div>}

    <div className="cal2-stats">
      <div><small>This week</small><b>{weekCount}</b></div>
      <div><small>Unassigned</small><b className={unassignedCount ? "warn" : ""}>{unassignedCount}</b></div>
      <div><small>Waiting for a time</small><b className={unscheduled.length ? "warn" : ""}>{unscheduled.length}</b></div>
      <div><small>Staff</small><b>{staff.length}</b></div>
    </div>

    <div className="cal2-layout">
      <section className="cal2-main">
        <div className="cal2-toolbar">
          <div className="cal2-nav">
            <Button variant="outline" size="sm" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))} aria-label="Previous week"><ChevronLeft size={15} /></Button>
            <Button variant="outline" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</Button>
            <Button variant="outline" size="sm" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))} aria-label="Next week"><ChevronRight size={15} /></Button>
          </div>
          <b className="cal2-range">{days[0].toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} – {days[6].toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</b>
          <div className="cal2-view" role="tablist" aria-label="Calendar view">
            <button type="button" role="tab" aria-selected={view === "week"} className={view === "week" ? "on" : ""} onClick={() => setView("week")}>Week</button>
            <button type="button" role="tab" aria-selected={view === "list"} className={view === "list" ? "on" : ""} onClick={() => setView("list")}>List</button>
          </div>
        </div>

        {view === "week" ? <div className="cal2-week-scroll"><div className="cal2-week">
          {days.map(day => {
            const items = itemsFor(day);
            const isToday = sameDay(day, today);
            return <div key={day.toISOString()} className={`cal2-day${isToday ? " today" : ""}`}>
              <div className="cal2-day-head">
                <span>{day.toLocaleDateString("en-IN", { weekday: "short" })}</span>
                <b>{day.getDate()}</b>
                {items.length > 0 && <em>{items.length}</em>}
              </div>
              <div className="cal2-day-body">{items.length === 0 ? <p className="cal2-empty">—</p> : items.map(card)}</div>
            </div>;
          })}
        </div></div> : <div className="cal2-list">
          {days.map(day => {
            const items = itemsFor(day);
            const isToday = sameDay(day, today);
            return <div key={day.toISOString()} className={`cal2-list-day${isToday ? " today" : ""}`}>
              <div className="cal2-list-head">
                <b>{day.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short" })}</b>
                {isToday && <span className="cal2-today-pill">Today</span>}
                <small>{items.length ? `${items.length} booking${items.length > 1 ? "s" : ""}` : "No bookings"}</small>
              </div>
              {items.length > 0 && <div className="cal2-list-grid">{items.map(card)}</div>}
            </div>;
          })}
        </div>}
      </section>

      <aside className="cal2-side">
        <section className="access-card">
          <div className="access-card-head"><div><h2>Waiting for a time</h2><p>Bookings without an appointment time.</p></div></div>
          {unscheduled.length === 0 ? <p className="cal2-empty-note">Nothing waiting.</p> :
            <div className="cal2-stack">{unscheduled.map(card)}</div>}
        </section>

        <section className="access-card">
          <div className="access-card-head"><div><h2>Medical staff</h2><p>The people who handle bookings.</p></div></div>
          <div className="cal2-staff-add">
            <input placeholder="Name" value={newStaff.name} onChange={e => setNewStaff({ ...newStaff, name: e.target.value })} />
            <input placeholder="Role (e.g. Phlebotomist)" value={newStaff.role} onChange={e => setNewStaff({ ...newStaff, role: e.target.value })} />
            <Button variant="default" size="sm" disabled={busy || newStaff.name.trim().length < 2 || newStaff.role.trim().length < 2} onClick={() => void addStaff()}><UserPlus size={13} /> Add staff</Button>
          </div>
          {staff.length === 0 ? <p className="cal2-empty-note">No staff yet. Add someone above to start assigning.</p> :
            <ul className="cal2-staff">{staff.map(s => <li key={s.id}>
              <span className="cal2-avatar">{s.name.split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase()}</span>
              <span className="cal2-staff-name"><b>{s.name}</b><small>{s.role}</small></span>
              <span className="cal2-staff-count">{appointments.filter(a => a.staffId === s.id && a.status !== "cancelled").length}</span>
              <Button variant="ghost" className="h-auto icon-button-small" aria-label={`Remove ${s.name}`} onClick={() => removeStaff(s)}><Trash2 size={13} /></Button>
            </li>)}</ul>}
        </section>
      </aside>
    </div>
  </div>;
}

/** Picks a day and a 30-minute slot, then saves it only when the user confirms. */
function ScheduleField({ disabled, onSave }: { disabled: boolean; onSave: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) return <Button variant="outline" size="sm" className="cal2-set-time" disabled={disabled} onClick={() => setOpen(true)}><CalendarDays size={13} /> Set time</Button>;
  return <div className="cal2-time">
    <DateTimeField value={value} onChange={setValue} disabled={disabled} />
    <div className="cal2-time-actions">
      <Button variant="default" size="sm" disabled={disabled || !value} onClick={() => onSave(value)}>Save time</Button>
      <Button variant="outline" size="sm" onClick={() => { setOpen(false); setValue(""); }}>Cancel</Button>
    </div>
  </div>;
}

/** Orders & Bookings: create a booking or a pre-booking, or see the calendar. */
export type OrdersTab = "book" | "prebook" | "calendar" | "tracker" | "form" | "results";
export function OrdersPage({ initialTab = "book" }: { initialTab?: OrdersTab } = {}) {
  const [tab, setTab] = useState<OrdersTab>(initialTab);
  // Tracker, settings and results have no page wrapper of their own, so the whole tab gets the standard page padding.
  // The other tabs bring their own wrapper; their tab bar is aligned to the same width and padding.
  const wrapped = tab === "tracker" || tab === "form" || tab === "results";
  const page = <>
    <div className={wrapped ? "" : "orders-tabs-bar"}><div className="orders-tabs segmented">
      <Button variant="ghost" className={cn("h-auto", tab === "book" ? "selected" : "")} onClick={() => setTab("book")}><Plus size={13} /> New booking</Button>
      <Button variant="ghost" className={cn("h-auto", tab === "prebook" ? "selected" : "")} onClick={() => setTab("prebook")}><Plus size={13} /> Pre-booking</Button>
      <Button variant="ghost" className={cn("h-auto", tab === "calendar" ? "selected" : "")} onClick={() => setTab("calendar")}><CalendarDays size={13} /> Calendar</Button>
      <Button variant="ghost" className={cn("h-auto", tab === "tracker" ? "selected" : "")} onClick={() => setTab("tracker")}><ClipboardList size={13} /> Tracker</Button>
      <Button variant="ghost" className={cn("h-auto", tab === "form" ? "selected" : "")} onClick={() => setTab("form")}><Settings2 size={13} /> Form settings</Button>
      <Button variant="ghost" className={cn("h-auto", tab === "results" ? "selected" : "")} onClick={() => setTab("results")}><Download size={13} /> Results</Button>
    </div></div>
    {tab === "book" ? <FlabsBookingForm /> : tab === "prebook" ? <PreBookingForm /> : tab === "tracker" ? <FlabsTracker /> : tab === "form" ? <BookingFormSettings /> : tab === "results" ? <FlabsResults /> : <CalendarPage />}
  </>;
  return wrapped ? <div className="content core-page flabs-theme orders-page">{page}</div> : page;
}
