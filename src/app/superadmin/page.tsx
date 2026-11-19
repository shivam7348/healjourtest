"use client";

import dynamic from "next/dynamic";

// "/superadmin": Super Admin sign-in and console (separate from /admin and the Lab Portal).
const SuperGate = dynamic(() => import("../../super/SuperGate"), { ssr: false });

export default function SuperAdminPage() {
  return <SuperGate />;
}
