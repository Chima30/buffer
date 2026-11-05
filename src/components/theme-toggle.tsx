"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => o.disconnect();
};
const current = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** Flips light and dark, remembers the choice, and tweens colours only. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, current, () => "dark");
  const next = theme === "dark" ? "light" : "dark";
  function flip() {
    const html = document.documentElement;
    html.classList.add("theme-tween");
    html.dataset.theme = next;
    try {
      localStorage.setItem("buffer-theme", next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    window.setTimeout(() => html.classList.remove("theme-tween"), 260);
  }
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={`press grid h-8 w-8 place-items-center rounded-full border border-rule-strong bg-surface text-ink-2 shadow-[var(--shadow-float)] transition-[color,background-color,transform] duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
    >
      <span className="relative h-4 w-4">
        <Sun size={16} strokeWidth={1.5} className={`absolute inset-0 transition-[opacity,transform] duration-200 ${theme === "light" ? "opacity-100" : "rotate-45 opacity-0"}`} />
        <Moon size={16} strokeWidth={1.5} className={`absolute inset-0 transition-[opacity,transform] duration-200 ${theme === "dark" ? "opacity-100" : "-rotate-45 opacity-0"}`} />
      </span>
    </button>
  );
}

function applyTheme(t: "light" | "dark") {
  const html = document.documentElement;
  html.classList.add("theme-tween");
  html.setAttribute("data-theme", t);
  try {
    localStorage.setItem("buffer-theme", t);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  window.setTimeout(() => html.classList.remove("theme-tween"), 260);
}

/** Sidebar footer switch: Light | Dark, with a sliding thumb. */
export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribe, current, () => "dark");
  const set = (t: "light" | "dark") => {
    if (t !== theme) applyTheme(t);
  };
  return (
    <div role="radiogroup" aria-label="Colour theme" className="relative grid h-9 grid-cols-2 rounded-lg border border-rule bg-raised p-0.5 text-xs">
      <span
        aria-hidden
        className={`absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-md bg-surface shadow-[var(--shadow-float)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${theme === "dark" ? "translate-x-full" : ""}`}
      />
      {(["light", "dark"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          onClick={() => set(t)}
          className={`relative z-10 flex items-center justify-center gap-1.5 rounded-md transition-colors duration-200 ${theme === t ? "text-ink" : "text-ink-3 hover:text-ink-2"}`}
        >
          {t === "light" ? <Sun size={14} strokeWidth={1.6} /> : <Moon size={14} strokeWidth={1.6} />}
          {t === "light" ? "Light" : "Dark"}
        </button>
      ))}
    </div>
  );
}

/** Runs before paint so the page never flashes the wrong theme. */
export const themeScript = `(function(){try{var t=localStorage.getItem("buffer-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}})();`;
