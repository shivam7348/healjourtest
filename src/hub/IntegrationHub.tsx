import { useEffect, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { hubApi } from "./shared";
import Payments from "./Payments";
import Communication from "./Communication";
import Leads from "./Leads";
import AppStore from "./AppStore";
import Reliability from "./Reliability";
import Compliance from "./Compliance";

type Tab = "payments" | "communication" | "leads" | "appstore" | "reliability" | "compliance";
const TABS: Array<[Tab, string]> = [["payments", "Payments"], ["communication", "Communication"], ["leads", "Leads & CRM"], ["appstore", "App Store"], ["reliability", "Reliability"], ["compliance", "Data protection"]];
type Overview = { modes: Record<string, string>; counts: { openAlerts: number }; encryption: { keyConfigured: boolean } };

/** Payments, communication, CRM, App Store, reliability ops and data protection, all on the connector framework. */
export default function IntegrationHub() {
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem("hub-tab") as Tab) || "payments"; } catch { return "payments"; } });
  const [ov, setOv] = useState<Overview | null>(null);
  useEffect(() => { try { localStorage.setItem("hub-tab", tab); } catch { /* private window */ } }, [tab]);
  useEffect(() => { void hubApi<Overview>("/api/hub/overview").then(setOv).catch(() => undefined); }, [tab]);
  const sandbox = ov ? Object.values(ov.modes).filter(m => m === "sandbox").length : 0;

  return <div className="content core-page flabs-theme hub-page">
    <div className="page-heading">
      <div><div className="eyebrow">INTEGRATION HUB</div><h1>Partner integrations</h1>
        <p>Payments, patient communication, lead capture, the App Store, reliability and data protection. Every partner call runs on the connector framework.</p></div>
    </div>
    {ov && <div className="hub-banner">
      {sandbox > 0 ? <span><b>{sandbox} connector(s) in sandbox mode.</b> They behave like the real partners; set the partner's keys on the server to go live.</span> : <span><b>All connectors are live.</b></span>}
      {ov.counts.openAlerts > 0 && <button type="button" onClick={() => setTab("reliability")}>{ov.counts.openAlerts} open alert(s)</button>}
      {!ov.encryption.keyConfigured && <button type="button" onClick={() => setTab("compliance")}>Encryption key not set</button>}
    </div>}
    <div className="cf-tabs segmented hub-tabs">
      {TABS.map(([v, label]) => <Button key={v} variant="ghost" className={cn("h-auto", tab === v ? "selected" : "")} onClick={() => setTab(v)}>{label}</Button>)}
    </div>
    {tab === "payments" && <Payments />}
    {tab === "communication" && <Communication />}
    {tab === "leads" && <Leads />}
    {tab === "appstore" && <AppStore />}
    {tab === "reliability" && <Reliability />}
    {tab === "compliance" && <Compliance />}
  </div>;
}
