import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../index.css";
import "../styles.css";
import "../sidebar-light.css";
import "../core-layers.css";
import "../reference-typography.css";
import "../dark-tokens.css";
import "../dark.css";
import { THEME_BOOT_SCRIPT } from "../lib/theme-boot";

export const metadata: Metadata = {
  title: "Healjour Integration Studio",
  description: "Connect labs, CRMs and payers to Healjour."
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0e111a" }
  ]
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script sets class="dark" before React loads, so the server markup can differ here.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
