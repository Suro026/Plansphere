"use client";

import * as React from "react";

/**
 * Animates every `[data-countup]` number on the page from 0 up to its real
 * value, progressively — mounted exactly once in the root layout, the same
 * way `Providers`/`ConsentProvider` are (an always-on client component next
 * to the app shell, not a conditional one rendered per `<Kpi>` instance).
 *
 * This replaced an earlier version where the count-up logic lived inside
 * `Kpi` itself as a small "use client" leaf, conditionally rendered by the
 * (hook-free) `primitives.tsx` whenever a Server Component passed `Kpi` a
 * plain number — architecturally the standard, textbook-correct way to
 * compose a client leaf into a server tree, and it worked in every local
 * reproduction (next dev, a genuine `next start` production server, and a
 * from-scratch `npm ci` install matching Vercel's own build command).
 *
 * It still reliably crashed `/f/[festSlug]`'s Server-Component render on
 * Vercel's actual deployment specifically, consistently, across two
 * independent redeploys of the identical, unchanged fix (one a no-op
 * commit, one forcing real recompilation of this exact module) — something
 * about that specific per-instance Server→Client crossing did not survive
 * Vercel's production runtime, for reasons this repo's own logs couldn't
 * surface (production redacts the underlying error, and no Sentry DSN is
 * configured in this deployment to capture it elsewhere).
 *
 * `Providers` proves an always-mounted root-level client component is fine
 * in this same environment (it runs on every page, including the ones that
 * never had a problem), so the count-up feature is kept, implemented this
 * way instead: `Kpi` (in primitives.tsx) stays 100% hook-free and renders
 * the correct final number directly — every page that uses it is exactly
 * as crash-proof as a Server Component that renders plain text, because
 * that is literally all it does now. This controller is the only piece
 * that touches React state, and it never sits in any page's server tree —
 * it finds its targets by querying the DOM after the real page has already
 * rendered and hydrated successfully.
 */
export const CountUpController = () => {
  React.useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const formatter = new Intl.NumberFormat("en-IN");
    const animated = new WeakMap<Element, number>();

    /**
     * React tags every DOM node it has claimed during hydration with a
     * `__reactFiber$…` property. Rewriting the text of a server-rendered number
     * before that happens makes hydration fail (React error #418) and throws the
     * whole boundary away to be client-rendered — measured on the throttled
     * mobile fest page, where this controller (mounted at the root, so it runs
     * before the page's own boundary finishes hydrating) did it on most loads.
     * So an element is left untouched, showing its correct final number, until
     * React owns it; if it is never claimed it simply stays as rendered.
     */
    const claimed = (el: HTMLElement) => Object.keys(el).some((key) => key.startsWith("__reactFiber$"));
    const waiting = new Set<HTMLElement>();
    const MAX_WAIT_MS = 15000;

    const animate = (el: HTMLElement) => {
      const target = Number(el.dataset.countup);
      if (!Number.isFinite(target)) return;
      if (!claimed(el)) {
        if (waiting.has(el)) return;
        waiting.add(el);
        const since = performance.now();
        const poll = () => {
          if (!el.isConnected || performance.now() - since > MAX_WAIT_MS) {
            waiting.delete(el);
          } else if (claimed(el)) {
            waiting.delete(el);
            animate(el);
          } else {
            requestAnimationFrame(poll);
          }
        };
        requestAnimationFrame(poll);
        return;
      }
      const from = animated.get(el) ?? 0;
      if (from === target) return;

      if (reduceMotion) {
        el.textContent = formatter.format(target);
        animated.set(el, target);
        return;
      }

      const duration = 600;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - (1 - t) ** 3;
        el.textContent = formatter.format(Math.round(from + (target - from) * eased));
        if (t < 1) requestAnimationFrame(tick);
        else animated.set(el, target);
      };
      requestAnimationFrame(tick);
    };

    const scan = (root: ParentNode) => {
      root.querySelectorAll<HTMLElement>("[data-countup]").forEach(animate);
    };

    scan(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.target instanceof HTMLElement) {
          animate(mutation.target);
        }
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            if (node.hasAttribute("data-countup")) animate(node);
            scan(node);
          }
        });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributeFilter: ["data-countup"] });

    return () => observer.disconnect();
  }, []);

  return null;
};
