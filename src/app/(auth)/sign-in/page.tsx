"use client";

import * as React from "react";
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
 * One system, one URL: students, volunteers, admins and super admins all
 * sign in through the same form against the same endpoint. The tabs change
 * the copy and — for "Create account" — the form, never the mechanism. There
 * is deliberately no organizer sign-up: those accounts are created by a super
 * admin (admins) or an admin (volunteers) and arrive by email.
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
    kick: "Organizers & volunteers",
    title: "Sign in",
    sub: "The same sign-in as everyone else. Use the email your fest's admin invited you with.",
  },
  create: {
    kick: "Students",
    title: "Create your account",
    sub: "One account for every fest you attend. Tickets, meal slots and certificates all land here.",
  },
  forgot: {
    kick: "Account",
    title: "Forgot your password?",
    sub: "Enter the address you signed up with and we'll send a link to set a new one.",
  },
};

const isTab = (value: string | null): value is Tab => TABS.some((t) => t.value === value);

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
    </>
  );
}
