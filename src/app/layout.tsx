import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../index.css";
import "../styles.css";
import "../sidebar-light.css";
import "../core-layers.css";
import "../reference-typography.css";

export const metadata: Metadata = {
  title: "Healjour Integration Studio",
  description: "Connect labs, CRMs and payers to Healjour."
};

export const viewport: Viewport = {
  themeColor: "#f6f8fc"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
