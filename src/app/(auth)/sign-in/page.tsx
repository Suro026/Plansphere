"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/providers";
import { AuthHeading } from "@/components/auth/auth-heading";
import { CreateAccountForm, ForgotPasswordForm, SignInForm } from "@/components/auth/auth-forms";
import { postAuthDestination } from "@/components/auth/destination";
import { Seg } from "@/components/ui/field";
import { safeRedirect } from "@/lib/utils";

/**
 * The single authentication page.
 *
 * One system, one URL: students, event teams and the platform team all sign in
 * through the same form against the same endpoint. The tabs change the copy
 * and — for "Create account" — the form, never the mechanism.
 *
 * Anyone can create an account here. Running your own college event is a
 * separate step, "Create a College Event" (/register-event), offered on every
 * tab and never gated behind an invitation. Invited team members (admins,
 * coordinators, volunteers) arrive by email and use the Organizer tab. Neither
 * path grants anything platform-wide: an event's creator becomes the Event
 * Super Admin of that one event once the Plansphere team approves it.
 *
 * Where you land afterwards comes from the claim on your token, not from the
 * tab you chose.
 */

const TABS = [
  { value: "student", label: "Student" },
  { value: "organizer", label: "Organizer" },
  { value: "create", label: "Create account" },
  { value: "forgot", label: "Forgot password" },
] as const;

type Tab = (typeof TABS)[number]["value"];

const COPY: Record<Tab, { kick: string; title: string; sub: string }> = {
  student: {
    kick: "Welcome back",
    title: "Sign in",
    sub: "Your passes, teams and certificates are here. New to Plansphere? Create an account — it takes a minute.",
  },
  organizer: {
    kick: "Event teams",
    title: "Sign in",
    sub: "For Event Super Admins, admins, coordinators and volunteers. Invited to a team? Use the email the invitation was sent to.",
  },
  create: {
    kick: "New to Plansphere",
    title: "Create your account",
    sub: "One account for everything: tickets, meal slots and certificates as a student, and the account you use to create a College Event.",
  },
  forgot: {
    kick: "Account",
    title: "Forgot your password?",
    sub: "Enter the address you signed up with and we'll send a link to set a new one.",
  },
};

const isTab = (value: string | null): value is Tab => TABS.some((t) => t.value === value);

/**
 * The way in for someone who wants to run their own event. Offered on every tab so event creation is never
 * only reachable through an organizer login. The destination handles signed-out visitors itself and returns them to
 * the application after they sign in or create an account.
 */
const CreateEventEntry = () => (
  <aside className="mt-8 border-t border-divider pt-6" aria-label="Create a College Event">
    <p className="mb-1 text-[11px] uppercase tracking-[0.14em] text-neutral-500">Running a college event?</p>
    <p className="mb-3 text-[13.5px] leading-relaxed text-neutral-400">
      Tech fest, cultural fest, sports meet or conference — create it yourself. The Plansphere team reviews each application before the event goes live, and once it is
      approved you run it as its Event Super Admin.
    </p>
    <Link href="/register-event" className="btn btn-secondary">
      Create a College Event
    </Link>
  </aside>
);

export default function AuthPage() {
  const { status, session, profile } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeRedirect(params.get("next"), "");

  const requested = params.get("tab");
  const [tab, setTab] = React.useState<Tab>(isTab(requested) ? requested : "student");

  // Deep links (?tab=create from the landing page, or the old /create-account
  // and /forgot-password URLs) select the tab without a reload.
  React.useEffect(() => {
    if (isTab(requested)) setTab(requested);
  }, [requested]);

  // Already signed in — send them wherever they belong.
  React.useEffect(() => {
    if (status === "signed-in" && session) router.replace(postAuthDestination(session, profile, next));
  }, [status, session, profile, next, router]);

  const copy = COPY[tab];

  return (
    <>
      <AuthHeading kick={copy.kick} title={copy.title} sub={copy.sub} />

      <Seg
        className="mb-6"
        fill
        options={TABS.map((t) => ({ value: t.value, label: t.label }))}
        value={tab}
        onChange={(value) => {
          setTab(value);
          // Keep the URL honest so a refresh or a shared link lands back here.
          const query = new URLSearchParams(params.toString());
          if (value === "student") query.delete("tab");
          else query.set("tab", value);
          router.replace(`/sign-in${query.size ? `?${query}` : ""}`, { scroll: false });
        }}
        aria-label="Authentication"
      />

      {tab === "create" ? (
        <CreateAccountForm next={next} />
      ) : tab === "forgot" ? (
        <ForgotPasswordForm />
      ) : (
        <SignInForm audience={tab} next={next} />
      )}

      {tab === "forgot" ? null : <CreateEventEntry />}
    </>
  );
}
