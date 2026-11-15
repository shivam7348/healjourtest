"use client";

import dynamic from "next/dynamic";

// The app reads browser-only state (window, clipboard), so it renders in the browser only.
// "/" is the Lab Portal: partner labs sign in here. Healjour admins use /admin.
const AuthGate = dynamic(() => import("../portal/AuthGate"), { ssr: false });

export default function Home() {
  return <AuthGate area="lab" />;
}
