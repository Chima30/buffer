"use client";

import { useEffect, useRef } from "react";

/**
 * Cards, tables and bars below the fold rise in as they scroll into view, once.
 * Anything already on screen is left alone (the page entrance handles it), so
 * nothing ever blinks out and back in. Bars, chart lines and staggered tiles
 * inside a card wait and play when the card arrives. New pages are picked up by
 * the mutation observer, so no router hook is needed. Off with reduced motion.
 */
const TARGETS = [
  'section',
  'article',
  'table',
  '[class~="rounded-[var(--radius-card)]"]',
  '[data-reveal]',
].join(",");

export function ScrollReveal({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const seen = new WeakSet<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const t = e.target;
          t.classList.add("reveal-in");
          t.classList.remove("reveal-wait");
          io.unobserve(t);
          // Hand the element back to its own hover transitions once it has landed.
          setTimeout(() => t.classList.remove("reveal-in"), 700);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    const scan = () => {
      const fold = window.innerHeight;
      el.querySelectorAll(TARGETS).forEach((t) => {
        if (seen.has(t)) return;
        seen.add(t);
        // Nested targets ride along with their outer card.
        if (t.parentElement?.closest(".reveal-wait, .reveal-in")) return;
        if (t.getBoundingClientRect().top < fold) return;
        t.classList.add("reveal-wait");
        io.observe(t);
      });
    };

    scan();
    let queued = false;
    const mo = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      io.disconnect();
    };
  }, []);

  return <div ref={root}>{children}</div>;
}
