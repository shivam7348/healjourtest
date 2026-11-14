"use client";

import dynamic from "next/dynamic";

// The studio is a single-page app that reads browser-only state (window, clipboard), so it renders in the browser only.
const App = dynamic(() => import("../App"), { ssr: false });

export default function Home() {
  return <App />;
}
