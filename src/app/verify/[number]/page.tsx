import type { Metadata } from "next";
import Link from "next/link";
import { Check, Warning } from "@phosphor-icons/react/dist/ssr";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { VerifySearch } from "@/components/verify/verify-search";
import { Button } from "@/components/ui/button";
import { MetaList, MetaRow, Tag } from "@/components/ui/primitives";
import { CERTIFICATE_LABELS, type CertificateType } from "@/core/models/certificate";
import { lookupCertificate, type PublicCertificate } from "@/server/public-lookup";
import { isAdminConfigured } from "@/server/firebase-admin";
import { formatClock } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ number: string }> };

const shortType = (type: string) => (CERTIFICATE_LABELS[type as CertificateType] ?? type).replace(/^Certificate of (Excellence — )?/, "");
const longDate = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : "—";
const shortDate = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(iso)) : "—");

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { number } = await params;
  return { title: `Verify ${number.toUpperCase()}`, robots: { index: false } };
}

/**
 * 3d — the page a recruiter lands on. Server-rendered from the record so the
 * verdict cannot be spoofed client-side; the recipient's contact details are
 * never part of the payload.
 */
export default async function VerifyCertificatePage({ params }: Params) {
  const { number } = await params;
  const fallback = { certificate: null, reason: "not-found" as const };
  const lookup = isAdminConfigured() ? await lookupCertificate(number).catch(() => fallback) : fallback;
  const cert = lookup.certificate;

  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav active="verify" />
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-[18px] pb-16 pt-6 sm:px-6 sm:pt-10 lg:px-10">
        {cert ? <Found cert={cert} /> : <NotFound number={number.toUpperCase()} reason={lookup.reason} />}
      </main>
      <PublicFooter />
    </div>
  );
}

const Found = ({ cert }: { cert: PublicCertificate }) => {
  const pdfHref = cert.fileUrl ?? `/api/verify/${cert.certificateNumber}/pdf`;
  return (
    <div className={cert.revoked ? "pl-5 shadow-[inset_3px_0_0_var(--color-neutral-600)]" : "pl-5 shadow-[inset_3px_0_0_var(--color-accent)]"}>
      <div className="mb-4 flex flex-wrap items-center gap-[9px]">
        {cert.revoked ? (
          <Tag tone="neutral" className="gap-[5px]">
            <Warning size={12} weight="bold" aria-hidden />
            Revoked certificate
          </Tag>
        ) : (
          <Tag tone="accent" className="gap-[5px]">
            <Check size={12} weight="bold" aria-hidden />
            Valid certificate
          </Tag>
        )}
        <span className="text-[12.5px] text-neutral-500">
          {cert.revoked ? `Withdrawn by the issuer on ${longDate(cert.revokedAt)}` : "Checked against the issuing college’s record just now"}
        </span>
      </div>
      <h1 className="mb-2.5 text-[32px] font-medium leading-[1.05] tracking-[-0.03em] sm:text-[40px]">{cert.recipientName}</h1>
      <div className="mb-6 text-[15px] text-neutral-300 sm:text-[16px]">
        {shortType(cert.type)}
        {cert.position ? ` · #${cert.position}` : ""} · {cert.eventTitle} · {cert.festSlug ? <Link href={`/f/${cert.festSlug}`}>{cert.festName}</Link> : cert.festName}
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_300px] lg:items-start">
        <MetaList>
          <MetaRow label="Certificate ID" mono>
            {cert.certificateNumber}
          </MetaRow>
          <MetaRow label="Issued by">{cert.issuer ?? cert.festName}</MetaRow>
          <MetaRow label="Issued on">{longDate(cert.issuedAt)}</MetaRow>
          <MetaRow label="Attendance">
            {cert.attendanceVerifiedAt
              ? `Verified at the gate, ${shortDate(cert.attendanceVerifiedAt)} ${formatClock(new Date(cert.attendanceVerifiedAt))}${cert.attendanceGate ? ` · ${cert.attendanceGate}` : ""}`
              : "Recorded by the organizer"}
          </MetaRow>
          {cert.teamName ? (
            <MetaRow label="Team">
              {cert.teamName} · {cert.memberCount} member{cert.memberCount === 1 ? "" : "s"}, each named individually
            </MetaRow>
          ) : null}
          <MetaRow label="Revoked">{cert.revoked ? `Yes — ${longDate(cert.revokedAt)}` : "No"}</MetaRow>
          <div className="mt-4 max-w-[52ch] text-[12.5px] text-neutral-500">
            Certificates are generated server-side once attendance is confirmed and the event has ended. A participant cannot issue their own.
          </div>
        </MetaList>

        <div>
          <div className="flex aspect-[1.414] items-center justify-center rounded-md border border-divider bg-surface text-center">
            <div className="px-6">
              <div className="code text-[12px] text-neutral-300">{cert.certificateNumber}</div>
              <div className="mt-1.5 text-[11.5px] text-neutral-500">{cert.revoked ? "Renders with a REVOKED banner" : "Certificate PDF"}</div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button asChild variant="primary" className="flex-1">
              <a href={pdfHref} target="_blank" rel="noopener">
                {cert.revoked ? "View PDF" : "Download PDF"}
              </a>
            </Button>
            <Button asChild variant="secondary">
              <a href={`mailto:support@plansphere.in?subject=${encodeURIComponent(`Certificate ${cert.certificateNumber}`)}`}>Report</a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

const NotFound = ({ number, reason }: { number: string; reason?: "malformed" | "not-found" }) => (
  <div className="pl-5 shadow-[inset_3px_0_0_var(--color-neutral-600)]">
    <div className="mb-4 flex items-center gap-[9px]">
      <Tag tone="neutral" className="gap-[5px]">
        <Warning size={12} weight="bold" aria-hidden />
        Not a valid certificate
      </Tag>
    </div>
    <h1 className="mb-2.5 text-[32px] font-medium leading-[1.05] tracking-[-0.03em] sm:text-[40px]">No record found</h1>
    <p className="mb-6 max-w-[52ch] text-[15px] text-neutral-300">
      {reason === "malformed"
        ? "That doesn’t look like a Plansphere certificate number. They are printed as FF, the year, and eight characters."
        : "This number doesn’t match any certificate we issued. It may have been mistyped, or the document may not be from Plansphere."}
    </p>
    <MetaList className="mb-8 max-w-[560px]">
      <MetaRow label="Number read" mono>
        {number}
      </MetaRow>
      <MetaRow label="What to do">Check the number under the QR code and try again</MetaRow>
    </MetaList>
    <div className="max-w-[560px]">
      <VerifySearch initial={reason === "malformed" ? "" : number} />
    </div>
  </div>
);
