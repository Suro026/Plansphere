"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AuthError } from "@/core/services/auth-service";
import { useAuth, useRepositories } from "@/components/providers";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";
import { MetaList, MetaRow, Tag } from "@/components/ui/primitives";
import { safeRedirect } from "@/lib/utils";

/**
 * Email verification — the waiting room after sign-up, and the landing page
 * for the link itself.
 *
 * Registration and certificates both send mail to this address, so an
 * unverified account can browse but cannot register. The gate is enforced by
 * `<RequireRole verified>` on those routes; this page is how someone gets
 * through it.
 */
export default function VerifyEmailPage() {
  const { auth, session, status, refresh } = useAuth();
  const repos = useRepositories();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeRedirect(params.get("next"), "/explore");
  const code = params.get("oobCode");
  const arrivedFromLink = params.get("done") === "1" || Boolean(code);

  const [applying, setApplying] = React.useState(Boolean(code));
  const [resent, setResent] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(0);

  // Arrived with a code: apply it, then mark the profile.
  React.useEffect(() => {
    if (!code) return;
    let cancelled = false;
    auth
      .applyEmailVerification(code)
      .then(async () => {
        await refresh();
        if (session?.uid) await repos.users.markEmailVerified(session.uid).catch(() => undefined);
        if (!cancelled) toast.success("Email verified");
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof AuthError ? error.message : "Could not verify that link.");
      })
      .finally(() => {
        if (!cancelled) setApplying(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per code
  }, [code]);

  // Verified (by any route) — mirror to the profile and move on.
  React.useEffect(() => {
    if (status === "signed-in" && session?.emailVerified) {
      repos.users.markEmailVerified(session.uid).catch(() => undefined);
      router.replace(next);
    }
  }, [status, session, next, router, repos]);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (status === "signed-out") {
    return (
      <>
        <AuthHeading kick="Account" title="Sign in to continue" sub="Verify your email from the account it belongs to." />
        <Button asChild variant="primary">
          <Link href={`/sign-in?next=${encodeURIComponent("/verify-email")}`}>Sign in</Link>
        </Button>
      </>
    );
  }

  const resend = async () => {
    try {
      await auth.sendVerificationEmail();
      setResent(true);
      setCooldown(45);
      toast.success("Verification email sent");
    } catch (error) {
      toast.error(error instanceof AuthError ? error.message : "Could not send the email.");
    }
  };

  const check = async () => {
    await refresh();
    const fresh = await auth.getSession();
    if (!fresh?.emailVerified) toast("Not verified yet — open the link in the email first.");
  };

  return (
    <>
      <AuthHeading
        kick="One more step"
        title={applying ? "Verifying…" : "Verify your email"}
        sub="We've sent a link to your inbox. Registering for events and receiving certificates needs a verified address."
      />

      <MetaList className="mb-6">
        <MetaRow label="Sent to">{session?.email ?? "—"}</MetaRow>
        <MetaRow label="Status">
          {session?.emailVerified ? <Tag tone="accent" check>Verified</Tag> : <Tag tone="neutral">Waiting</Tag>}
        </MetaRow>
        {arrivedFromLink && !applying && !session?.emailVerified ? (
          <MetaRow label="Link">Opened — tap “I’ve verified” if this doesn’t update</MetaRow>
        ) : null}
      </MetaList>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={check} loading={applying}>
          I’ve verified
        </Button>
        <Button variant="secondary" onClick={resend} disabled={cooldown > 0}>
          {cooldown > 0 ? `Resend in ${cooldown}s` : resent ? "Resend again" : "Resend email"}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/explore">Browse fests meanwhile</Link>
        </Button>
      </div>

      <p className="mt-6 max-w-[44ch] text-[12.5px] text-neutral-500">
        Wrong address? Sign out and create the account again with the right one — nothing is tied to this one yet.
      </p>
    </>
  );
}
