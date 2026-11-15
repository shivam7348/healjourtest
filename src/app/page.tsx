"use client";

import dynamic from "next/dynamic";

// The studio is a single-page app that reads browser-only state (window, clipboard), so it renders in the browser only.
// AuthGate shows sign-in first, then the Lab Portal (lab users) or the full admin app (Healjour admins).
const App = dynamic(() => import("../portal/AuthGate"), { ssr: false });

export default function Home() {
  return <App />;
}
