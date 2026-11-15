"use client";

import dynamic from "next/dynamic";

// "/admin": Healjour admin sign-in (and first-run setup), then the full admin app.
const AuthGate = dynamic(() => import("../../portal/AuthGate"), { ssr: false });

export default function AdminPage() {
  return <AuthGate area="admin" />;
}
