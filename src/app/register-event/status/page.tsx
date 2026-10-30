"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/providers";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { Button } from "@/components/ui/button";
import { Kick, Note, Skeleton } from "@/components/ui/primitives";
import { api, ApiClientError } from "@/data/api-client";

/**
 * Where the caller's event applications stand: pending, approved or rejected. The applicant is not staff, so they
 * cannot read their draft event from Firestore; `GET /api/register-event` returns just what they need.
 */
interface Application {
  festId: string;
  name: string;
  slug: string;
  status: "pending" | "approved" | "rejected";
  submittedAt?: string;
  message: string;
  reason?: string;
}

const LABEL: Record<Application["status"], string> = {
  pending: "Pending verification",
  approved: "Approved",
  rejected: "Not approved",
};

export default function RegistrationStatusPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav active="colleges" />
      <main id="main" className="mx-auto w-full max-w-[680px] flex-1 px-[18px] pb-16 pt-8 sm:px-6 sm:pt-14">
        <span className="mb-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-600">[ your applications ]</span>
        <h1 className="mb-9 text-[36px] leading-[0.98] tracking-[-0.03em] sm:text-[48px]">Where your event stands</h1>
        <Applications />
      </main>
      <PublicFooter />
    </div>
  );
}

const Applications = () => {
  const { status, session, auth } = useAuth();
  const query = useQuery({
    queryKey: ["register-event", "applications", session?.uid],
    enabled: Boolean(session),
    queryFn: () => api<{ applications: Application[]; emailVerified?: boolean }>("/api/register-event"),
  });

  if (status === "loading") return <Skeleton className="h-40" />;

  if (status === "signed-out" || !session) {
    return (
      <Note title="Sign in to see your applications">
        <div className="mt-3.5">
          <Button asChild variant="primary">
            <Link href="/sign-in?next=/register-event/status">Sign in</Link>
          </Button>
        </div>
      </Note>
    );
  }

  if (query.isLoading) return <Skeleton className="h-40" />;
  if (query.isError) {
    return <Note title="Couldn't load your applications">{query.error instanceof ApiClientError ? query.error.message : "Try again in a moment."}</Note>;
  }

  const applications = query.data?.applications ?? [];
  if (applications.length === 0) {
    return (
      <Note title="No applications yet">
        <div className="mt-3.5">
          <Button asChild variant="primary">
            <Link href="/register-event">Register an event</Link>
          </Button>
        </div>
      </Note>
    );
  }

  const waitingOnEmail = query.data?.emailVerified === false && applications.some((application) => application.status === "pending");

  return (
    <>
    {waitingOnEmail ? (
      <Note title="Verify your email address">
        An application can only be approved once the email address on your account is verified.
        <div className="mt-3.5">
          <Button asChild variant="secondary">
            <Link href="/verify-email">Verify my email</Link>
          </Button>
        </div>
      </Note>
    ) : null}
    <ul className="flex flex-col gap-4">
      {applications.map((application) => (
        <li key={application.festId} className="rounded-xl border border-divider p-5">
          <Kick>{LABEL[application.status]}</Kick>
          <h2 className="mb-1.5 mt-1 text-[22px] tracking-[-0.02em]">{application.name}</h2>
          <p className="text-[14px] text-neutral-400">{application.message}</p>
          {application.reason ? <p className="mt-2 text-[14px]">Reason: {application.reason}</p> : null}
          {application.status === "approved" ? (
            <div className="mt-4">
              <Button
                variant="primary"
                onClick={async () => {
                  // The approval changed this account's role on the server; the token this browser holds predates it.
                  await auth.getIdToken(true);
                  window.location.assign(`/admin/${application.slug}/overview`);
                }}
              >
                Open the console
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
    </>
  );
};
