import { useEffect, useMemo, useState } from "react";
import { Bell, FileText, FlaskConical, Repeat2, X } from "lucide-react";
import { api } from "./api";

type Item = { id: string; caseId: string; caseNo: string; labName: string; action: string; note?: string; status?: string; by: string; role: string; at: string; fromLab: boolean; reportUrl?: string };

const SEEN_KEY = "hj-notif-seen";
const readSeen = (): string => { try { return localStorage.getItem(SEEN_KEY) ?? ""; } catch { return ""; } };
const writeSeen = (at: string) => { try { localStorage.setItem(SEEN_KEY, at); } catch { /* private window: badge just resets on reload */ } };

const iconFor = (action: string) => {
  const a = action.toLowerCase();
  if (a.includes("report")) return <FileText size={18} />;
  if (a.includes("result")) return <FlaskConical size={18} />;
  return <Repeat2 size={18} />;
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Bell with unread badge and a side panel listing case events (status, results, reports).
 * Lab users see their own lab; Healjour admins see every lab.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(readSeen);

  const load = async () => {
    try { setItems((await api<{ items: Item[] }>("/api/portal/notifications")).items); } catch { /* keep last list */ }
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, []);

  const visible = useMemo(() => items.filter(i => !dismissed.has(i.id)), [items, dismissed]);
  const unread = visible.filter(i => i.at > seen).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) { void load(); }
  };
  const clearAll = () => {
    const newest = items[0]?.at ?? new Date().toISOString();
    writeSeen(newest); setSeen(newest);
    setDismissed(new Set(items.map(i => i.id)));
  };
  const dismiss = (id: string) => setDismissed(prev => new Set(prev).add(id));

  return <>
    <button type="button" className="notif-bell" aria-label="Notifications" onClick={toggle}>
      <Bell size={19} />
      {unread > 0 && <span className="notif-badge">{unread > 99 ? "99+" : unread}</span>}
    </button>

    {open && <div className="notif-overlay" onClick={() => setOpen(false)}>
      <aside className="notif-panel" role="dialog" aria-label="Notifications" onClick={e => e.stopPropagation()}>
        <div className="notif-head">
          <button type="button" className="notif-icon-btn" aria-label="Close" onClick={() => setOpen(false)}><X size={18} /></button>
          <h2>Notifications</h2>
          <button type="button" className="notif-clear" onClick={clearAll} disabled={visible.length === 0}>Clear All</button>
        </div>
        <div className="notif-list">
          {visible.length === 0 && <p className="notif-empty">No notifications yet.</p>}
          {visible.map(n => <article key={n.id} className={`notif-card${n.at > seen ? " unread" : ""}`}>
            <div className="notif-card-head">
              <span className="notif-kind">{iconFor(n.action)}<b>{n.action}</b></span>
              <button type="button" className="notif-icon-btn" aria-label="Dismiss" onClick={() => dismiss(n.id)}><X size={16} /></button>
            </div>
            <p>{n.caseNo} · {n.labName}{n.by ? ` · by ${n.by}` : ""}{n.note ? ` — ${n.note}` : ""}</p>
            {n.reportUrl && <p className="notif-report">Report: <a href={n.reportUrl} target="_blank" rel="noopener noreferrer">Open report</a></p>}
            <time>{when(n.at)}</time>
          </article>)}
        </div>
      </aside>
    </div>}
  </>;
}
