"use client";

import * as React from "react";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Button } from "@/components/ui/button";

/**
 * Cookie / analytics consent.
 *
 * Plansphere sets no advertising cookies; the only optional processing is
 * Vercel Analytics + Speed Insights, which are cookieless but still a
 * third party, so they load only after "Accept". Essential storage (the
 * sign-in session, the offline pass) is not subject to the choice and the
 * banner says so. The decision persists in localStorage and can be changed
 * from the footer.
 */

const KEY = "plansphere.consent.v1";
type Choice = "accepted" | "rejected";

const read = (): Choice | null => {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "accepted" || v === "rejected" ? v : null;
  } catch {
    return null;
  }
};

const ConsentContext = React.createContext<{ choice: Choice | null; setChoice: (c: Choice) => void; reopen: () => void }>({
  choice: null,
  setChoice: () => undefined,
  reopen: () => undefined,
});

export const useConsent = () => React.useContext(ConsentContext);

export const ConsentProvider = ({ children }: { children: React.ReactNode }) => {
  const [choice, setChoiceState] = React.useState<Choice | null>(null);
  const [ready, setReady] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const stored = read();
    setChoiceState(stored);
    setOpen(stored === null);
    setReady(true);
  }, []);

  const setChoice = React.useCallback((c: Choice) => {
    setChoiceState(c);
    setOpen(false);
    try {
      window.localStorage.setItem(KEY, c);
    } catch {
      // Private mode: the choice lasts for this page load only.
    }
  }, []);

  const value = React.useMemo(() => ({ choice, setChoice, reopen: () => setOpen(true) }), [choice, setChoice]);

  return (
    <ConsentContext.Provider value={value}>
      {children}
      {choice === "accepted" ? (
        <>
          <Analytics />
          <SpeedInsights />
        </>
      ) : null}
      {ready && open ? <ConsentBanner onChoice={setChoice} /> : null}
    </ConsentContext.Provider>
  );
};

const ConsentBanner = ({ onChoice }: { onChoice: (c: Choice) => void }) => (
  <div
    role="dialog"
    aria-labelledby="consent-title"
    aria-describedby="consent-body"
    className="fixed inset-x-0 bottom-0 z-[60] px-[14px] pb-[calc(14px+env(safe-area-inset-bottom))] sm:bottom-5 sm:left-auto sm:right-5 sm:w-[420px] sm:px-0 sm:pb-0"
  >
    <div className="panel bg-surface p-4 shadow-[var(--shadow-lg)]">
      <div id="consent-title" className="mb-1 text-[14.5px] font-medium">
        Cookies &amp; analytics
      </div>
      <p id="consent-body" className="mb-3 text-[12.5px] leading-relaxed text-neutral-300">
        Signing in and your offline pass use essential storage that isn’t optional. Separately, we’d like to measure page performance with cookieless
        Vercel Analytics. No advertising, no cross-site tracking.{" "}
        <Link href="/privacy" className="text-accent-300">
          Privacy Policy
        </Link>
      </p>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" className="flex-1" onClick={() => onChoice("accepted")}>
          Accept analytics
        </Button>
        <Button variant="secondary" size="sm" className="flex-1" onClick={() => onChoice("rejected")}>
          Reject
        </Button>
      </div>
    </div>
  </div>
);

/** Footer link that lets people revisit the choice. */
export const ConsentSettingsLink = ({ className }: { className?: string }) => {
  const { reopen } = useConsent();
  return (
    <button type="button" onClick={reopen} className={className}>
      Cookie settings
    </button>
  );
};
