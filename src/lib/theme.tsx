import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { THEME_KEY as KEY } from "./theme-boot";

export type ThemeChoice = "light" | "dark" | "system";

const prefersDark = () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
const apply = (choice: ThemeChoice) => document.documentElement.classList.toggle("dark", choice === "dark" || (choice === "system" && prefersDark()));

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    if (typeof window === "undefined") return "system";
    return (localStorage.getItem(KEY) as ThemeChoice | null) ?? "system";
  });
  useEffect(() => {
    apply(choice);
    try { localStorage.setItem(KEY, choice); } catch { /* private mode */ }
    if (choice !== "system") return;
    // Follow the operating system while on "system".
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);
  return [choice, setChoice] as const;
}

const NEXT: Record<ThemeChoice, ThemeChoice> = { light: "dark", dark: "system", system: "light" };
const LABEL: Record<ThemeChoice, string> = { light: "Light mode", dark: "Night mode", system: "Same as device" };

/** One button that cycles Light → Night → Same as device. */
export function ThemeToggle({ className = "theme-toggle" }: { className?: string }) {
  const [choice, setChoice] = useTheme();
  const Icon = choice === "dark" ? Moon : choice === "light" ? Sun : Monitor;
  return <button type="button" className={className} aria-label={`Theme: ${LABEL[choice]}. Switch to ${LABEL[NEXT[choice]]}`}
    title={`${LABEL[choice]} — click for ${LABEL[NEXT[choice]]}`} onClick={() => setChoice(NEXT[choice])}>
    <Icon size={16} />
  </button>;
}
