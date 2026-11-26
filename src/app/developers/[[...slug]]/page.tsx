"use client";

import dynamic from "next/dynamic";
import "../../../developers/developers.css";

// "/developers": public API docs and the self-serve developer console (no admin login).
const DevSite = dynamic(() => import("../../../developers/DevSite"), { ssr: false });

export default function DevelopersPage() {
  return <DevSite />;
}
