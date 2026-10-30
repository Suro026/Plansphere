"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useAuth, useRepositories } from "@/components/providers";
import { useFestEvents } from "@/components/admin/hooks";
import { useReleasePreview, usePublishCertificates } from "@/components/admin/platform-api";
import { ImageUploadField } from "@/components/ui/image-upload";
import { Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, Dialog, DialogContent } from "@/components/ui/overlays";
import { Artwork, Bar, EmptyState, Kick, Note, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import type { Event } from "@/core/models/event";
import { CERTIFICATE_LABELS, type Certificate } from "@/core/models/certificate";
import { RepositoryError } from "@/core/models/common";
import { hasAtLeast } from "@/core/models/user";
import { formatCalendarDate, formatCount, formatRelative } from "@/lib/utils";

interface EventRow {
  event: Event;
  issued: number;
  resultsPublished: boolean;
  needsResults: boolean;
  lastIssued: Date | null;
  delivered: number;
  pending: number;
}

/**
 * Certificate center. One event at a time, walked as a pipeline: results,
 * eligibility, generation, delivery. Everything here is a server route; a
 * client cannot mint a certificate. What a given event's admin may actually
 * do — prepare only, or prepare and release — comes straight from
 * `canPublish` on the eligibility read, not a role check written here.
 */
export default function CertificateCenterPage() {
  const { fest, basePath } = useFest();
  const { session } = useAuth();
  const repos = useRepositories();
  const client = useQueryClient();
  const events = useFestEvents(fest.id);
  const [pipelineFor, setPipelineFor] = React.useState<Event | null>(null);
  const [sendingAll, setSendingAll] = React.useState(false);

  const isAdmin = session ? hasAtLeast(session.role, "admin") : false;

  const certs = useQuery({
    queryKey: ["fest-certificates", fest.id],
    queryFn: async () => {
      const page = await repos.certificates.list({ festId: fest.id, includeRevoked: true, limit: 1000 });
      return page.items;
    },
    staleTime: 15_000,
  });

  const rows = React.useMemo<EventRow[]>(() => {
    const all = certs.data ?? [];
    return (events.data ?? [])
      .filter((e) => e.status !== "draft" && e.status !== "cancelled")
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((event) => {
        const mine = all.filter((c) => c.eventId === event.id && !c.revoked);
        return {
          event,
          issued: mine.length,
          resultsPublished: Boolean(event.resultsPublishedAt),
          needsResults: event.eventType === "team" || event.category === "hackathon",
          lastIssued: mine.reduce<Date | null>((m, c) => (!m || c.issuedAt > m ? c.issuedAt : m), null),
          delivered: mine.filter((c) => c.delivery.status === "sent").length,
          pending: mine.filter((c) => c.delivery.status !== "sent").length,
        };
      });
  }, [events.data, certs.data]);

  const total = (certs.data ?? []).filter((c) => !c.revoked).length;
  const awaitingEmail = (certs.data ?? []).filter((c) => !c.revoked && c.delivery.status !== "sent").length;

  const sendAllPending = async () => {
    setSendingAll(true);
    try {
      const r = await repos.certificates.deliverPending(fest.id);
      if (r.reason) toast(r.reason);
      else toast.success(`${r.sent} sent · ${r.failed} failed`);
      client.invalidateQueries({ queryKey: ["fest-certificates", fest.id] });
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't send");
    } finally {
      setSendingAll(false);
    }
  };

  const stageFor = (r: EventRow) => {
    if (r.event.status !== "completed") return <Tag tone="neutral">Event not ended</Tag>;
    if (r.issued > 0 && r.pending === 0) return <Tag tone="accent" check>Delivered</Tag>;
    if (r.issued > 0) return <Tag tone="neutral">Generated · {r.pending} to send</Tag>;
    if (r.needsResults && !r.resultsPublished) return <Tag tone="neutral">Awaiting results</Tag>;
    return <Tag tone="accent">Ready to generate</Tag>;
  };

  return (
    <AdminPage className="pb-8 pt-[26px]">
      <PageHeading
        title="Certificate center"
        sub={`${formatCount(total)} issued so far${awaitingEmail ? ` · ${awaitingEmail} awaiting email` : ""}`}
        actions={
          isAdmin && awaitingEmail > 0 ? (
            <Button variant="primary" onClick={sendAllPending} loading={sendingAll}>
              Send {awaitingEmail} pending
            </Button>
          ) : null
        }
        className="mb-5"
      />

      {events.loading || certs.isPending ? (
        <Skeleton className="h-56" />
      ) : rows.length === 0 ? (
        <EmptyState title="No events to certify yet" body="Events appear here once they are published. Certificates unlock when an event is marked completed." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Checked in</th>
                <th>Issued</th>
                <th>Stage</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.event.id}>
                  <td>
                    <Link href={`${basePath}/events/${r.event.slug}/settings`} className="text-inherit no-underline hover:text-accent">
                      {r.event.title}
                    </Link>
                    <div className="text-[11.5px] text-neutral-500">{formatCalendarDate(r.event.date)}</div>
                  </td>
                  <td>
                    <CheckedInCount eventId={r.event.id} />
                  </td>
                  <td>{r.issued}</td>
                  <td>{stageFor(r)}</td>
                  <td className="whitespace-nowrap text-right">
                    {r.event.status === "completed" ? (
                      <button type="button" className="btn btn-ghost text-[12px]" onClick={() => setPipelineFor(r.event)}>
                        Open
                      </button>
                    ) : (
                      <span className="text-[12px] text-neutral-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={pipelineFor !== null} onOpenChange={(o) => !o && setPipelineFor(null)}>
        {pipelineFor ? (
          <DialogContent title={pipelineFor.title} description={formatCalendarDate(pipelineFor.date)} size="lg">
            <CertificatePipeline
              event={pipelineFor}
              fest={fest}
              isAdmin={isAdmin}
              certificates={(certs.data ?? []).filter((c) => c.eventId === pipelineFor.id)}
              onChanged={() => client.invalidateQueries({ queryKey: ["fest-certificates", fest.id] })}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </AdminPage>
  );
}

const CheckedInCount = ({ eventId }: { eventId: string }) => {
  const repos = useRepositories();
  const q = useQuery({ queryKey: ["event-checkins", eventId], queryFn: () => repos.attendance.countByEvent(eventId), staleTime: 30_000 });
  return <>{q.data ?? "…"}</>;
};

/* ───────────────────────── the four-stage pipeline ───────────────────────── */

const STAGES = ["Results", "Eligible", "Generate", "Delivery"] as const;

const StageRail = ({ at }: { at: number }) => (
  <div className="mb-6 flex items-center gap-2">
    {STAGES.map((label, i) => (
      <React.Fragment key={label}>
        {i > 0 ? <div className="h-px w-6 bg-divider" aria-hidden /> : null}
        <div className={`flex items-center gap-1.5 text-[12.5px] ${i === at ? "text-text" : i < at ? "text-accent-300" : "text-neutral-500"}`}>
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
              i === at ? "border-accent-300 text-accent-300" : i < at ? "border-accent-300 bg-accent-300/10 text-accent-300" : "border-divider"
            }`}
          >
            {i + 1}
          </span>
          {label}
        </div>
      </React.Fragment>
    ))}
  </div>
);

const CertificatePipeline = ({
  event,
  fest,
  isAdmin,
  certificates,
  onChanged,
}: {
  event: Event;
  fest: { id: string; name: string; organizationName: string };
  isAdmin: boolean;
  certificates: Certificate[];
  onChanged: () => void;
}) => {
  const repos = useRepositories();
  const client = useQueryClient();
  const preview = useReleasePreview(event.id);
  const publish = usePublishCertificates();
  const [templateUrl, setTemplateUrl] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [revoking, setRevoking] = React.useState<Certificate | null>(null);
  const [reason, setReason] = React.useState("");
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  const [search, setSearch] = React.useState("");

  React.useEffect(() => {
    setTemplateUrl(preview.data?.templateUrl ?? "");
  }, [preview.data?.templateUrl]);

  const needsResults = event.eventType === "team" || event.category === "hackathon";
  const resultsPublished = Boolean(event.resultsPublishedAt);
  const resultsReady = !needsResults || resultsPublished;

  const issued = certificates.filter((c) => !c.revoked);
  const sent = issued.filter((c) => c.delivery.status === "sent");
  const failed = issued.filter((c) => c.delivery.status === "failed");
  const pending = issued.filter((c) => c.delivery.status !== "sent" && c.delivery.status !== "failed");

  const participationEligible = preview.data ? (preview.data.byType.participation ?? 0) : 0;
  const winnerEligible = preview.data ? Object.entries(preview.data.byType).reduce((sum, [type, n]) => (type === "participation" ? sum : sum + n), 0) : 0;
  const totalEligible = participationEligible + winnerEligible;

  const stageIndex = issued.length > 0 ? (pending.length === 0 && failed.length === 0 ? 3 : 2) : resultsReady ? 1 : 0;

  const generate = async () => {
    setGenerating(true);
    try {
      if (preview.data?.canPublish) {
        const changed = templateUrl && templateUrl !== preview.data.templateUrl;
        const summary = await publish.mutateAsync({ eventId: event.id, ...(changed ? { templateUrl } : {}) });
        toast.success(`${summary.published} released · ${summary.emailed} emailed${summary.failed ? ` · ${summary.failed} failed` : ""}`);
      } else {
        const summary = await repos.certificates.generateForEvent(event.id, { dryRun: false });
        toast.success(`${summary.created} prepared${summary.existing ? ` · ${summary.existing} already held one` : ""} — a platform admin releases them from here`);
      }
      client.invalidateQueries({ queryKey: ["certificate-release", event.id] });
      onChanged();
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const retry = async () => {
    setSending(true);
    try {
      const r = await repos.certificates.deliverPending(fest.id, event.id);
      if (r.reason) toast(r.reason);
      else toast.success(`${r.sent} sent · ${r.failed} failed`);
      onChanged();
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't send");
    } finally {
      setSending(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    if (reason.trim().length < 3) {
      toast.error("Say why — it's kept with the record.");
      return;
    }
    setRevokeBusy(true);
    try {
      await repos.certificates.revoke(revoking.id, reason);
      toast.success(`Revoked ${revoking.certificateNumber}`);
      setRevoking(null);
      setReason("");
      onChanged();
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't revoke");
    } finally {
      setRevokeBusy(false);
    }
  };

  const term = search.trim().toLowerCase();
  const rows = issued
    .concat(certificates.filter((c) => c.revoked))
    .filter((c) => !term || c.recipientName.toLowerCase().includes(term) || c.recipientEmail.toLowerCase().includes(term) || c.certificateNumber.toLowerCase().includes(term))
    .sort((a, b) => a.recipientName.localeCompare(b.recipientName));

  const tone = (c: Certificate): "danger" | "accent" | "neutral" => (c.revoked ? "danger" : c.delivery.status === "sent" ? "accent" : c.delivery.status === "failed" ? "danger" : "neutral");
  const label = (c: Certificate) =>
    c.revoked ? "Revoked" : c.delivery.status === "sent" ? `Sent${c.delivery.sentAt ? ` · ${formatRelative(c.delivery.sentAt)}` : ""}` : c.delivery.status === "failed" ? "Failed" : "Pending";

  return (
    <div className="flex flex-col gap-6">
      <StageRail at={stageIndex} />

      {/* Stage 1 — Results published */}
      <section>
        <Kick className="mb-2">1 · Results published</Kick>
        {!needsResults ? (
          <Note title="No result sheet needed">This event doesn't rank participants — everyone who checked in is eligible for a participation certificate as soon as they're scanned at the gate.</Note>
        ) : resultsPublished ? (
          <Tag tone="accent" check>
            Published
          </Tag>
        ) : (
          <Note title="Results aren't published yet">Winner certificates need a published result sheet. Participation certificates don't wait on this.</Note>
        )}
      </section>

      {/* Stage 2 — Eligible participants */}
      <section>
        <Kick className="mb-2">2 · Eligible participants</Kick>
        {preview.isPending ? (
          <Skeleton className="h-16" />
        ) : preview.isError || !preview.data ? (
          <Note title="Couldn't work out who's eligible">Reads registrations, attendance and the result sheet — one of them couldn't be read. Try again in a moment.</Note>
        ) : (
          <div className="flex flex-wrap gap-4">
            <div className="rounded-md border border-divider px-4 py-3">
              <div className="text-[24px] leading-none tracking-[-0.02em]">{formatCount(totalEligible)}</div>
              <div className="mt-1 text-[12px] text-neutral-500">Eligible in total</div>
            </div>
            <div className="rounded-md border border-divider px-4 py-3">
              <div className="text-[24px] leading-none tracking-[-0.02em]">{formatCount(participationEligible)}</div>
              <div className="mt-1 text-[12px] text-neutral-500">Participation</div>
            </div>
            <div className="rounded-md border border-divider px-4 py-3">
              <div className="text-[24px] leading-none tracking-[-0.02em]">{formatCount(winnerEligible)}</div>
              <div className="mt-1 text-[12px] text-neutral-500">Winner &amp; awards</div>
            </div>
          </div>
        )}
        {preview.data && preview.data.unmatched.length > 0 ? (
          <Note title={`${preview.data.unmatched.length} eligible ${preview.data.unmatched.length === 1 ? "person hasn't" : "people haven't"} signed up`} className="mt-3">
            They'll appear here automatically once they create an account with the same email — re-open this then.
          </Note>
        ) : null}
      </section>

      {/* Stage 3 — Generate certificates */}
      <section>
        <Kick className="mb-2">3 · Generate certificates</Kick>
        <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
          <div className="flex flex-col gap-2">
            {preview.data?.canPublish ? (
              <ImageUploadField
                id="cert-template"
                label="Certificate artwork"
                kind="certificateTemplate"
                ownerId={fest.id}
                value={templateUrl}
                onChange={setTemplateUrl}
                aspect="1414/1000"
                allowUrl={false}
                hint="Optional — A4 landscape. Blank uses the Plansphere design."
              />
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="aspect-[1.414] w-full overflow-hidden rounded-md">
                  <Artwork src={templateUrl || null} label="Default design" className="h-full w-full" />
                </div>
                <div className="text-[11.5px] text-neutral-500">A platform admin sets custom artwork when they release these.</div>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <div className="min-w-[140px] flex-1 rounded-md border border-divider px-3.5 py-2.5">
                <div className="text-[12px] text-neutral-500">Participation certificates</div>
                <div className="text-[18px] tracking-[-0.02em]">{formatCount(issued.filter((c) => c.type === "participation").length)} / {formatCount(participationEligible)}</div>
              </div>
              <div className="min-w-[140px] flex-1 rounded-md border border-divider px-3.5 py-2.5">
                <div className="text-[12px] text-neutral-500">Winner certificates</div>
                <div className="text-[18px] tracking-[-0.02em]">{formatCount(issued.filter((c) => c.type !== "participation").length)} / {formatCount(winnerEligible)}</div>
              </div>
            </div>

            {generating ? (
              <div>
                <Bar value={0.66} className="animate-pulse" />
                <div className="mt-1.5 text-[12px] text-neutral-500">Generating…</div>
              </div>
            ) : null}

            <div>
              <Button variant="primary" onClick={generate} loading={generating} disabled={totalEligible === 0 || preview.isPending}>
                {preview.data?.canPublish ? "Generate & release" : "Generate certificates"}
              </Button>
              <div className="mt-1.5 text-[12px] text-neutral-500">
                {preview.data?.canPublish
                  ? "Emails go out the moment this finishes — there's no undo, only revoke."
                  : "This prepares the certificates. A platform admin releases and emails them."}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stage 4 — Email & verification */}
      <section>
        <Kick className="mb-2">4 · Email &amp; verification</Kick>
        {issued.length === 0 ? (
          <div className="text-[13px] text-neutral-500">Nothing generated yet.</div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone="accent">{sent.length} sent</Tag>
              <Tag tone="danger">{failed.length} failed</Tag>
              <Tag tone="neutral">{pending.length} pending</Tag>
              {isAdmin && failed.length + pending.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={retry} loading={sending}>
                  Retry {failed.length + pending.length}
                </Button>
              ) : null}
              <Input type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="ml-auto w-[180px]" aria-label="Search certificates" />
            </div>
            <div className="table-wrap max-h-[40dvh] overflow-y-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className={c.revoked ? "opacity-60" : ""}>
                      <td>
                        {c.recipientName}
                        <div className="text-[11.5px] text-neutral-500">{c.recipientEmail}</div>
                      </td>
                      <td className="whitespace-nowrap">{CERTIFICATE_LABELS[c.type].replace("Certificate of ", "").replace("Excellence — ", "")}</td>
                      <td>
                        <Tag tone={tone(c)}>{label(c)}</Tag>
                        {c.delivery.lastError ? (
                          <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-neutral-500" title={c.delivery.lastError}>
                            {c.delivery.lastError}
                          </div>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <a href={`/verify/${c.certificateNumber}`} target="_blank" rel="noreferrer" className="btn btn-ghost text-[12px]">
                          View
                        </a>
                        {c.fileUrl ? (
                          <a href={c.fileUrl} target="_blank" rel="noreferrer" className="btn btn-ghost text-[12px]">
                            PDF
                          </a>
                        ) : null}
                        {isAdmin && !c.revoked ? (
                          <button type="button" className="btn btn-ghost text-[12px] text-danger" onClick={() => setRevoking(c)}>
                            Revoke
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <AlertDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        {revoking ? (
          <AlertDialogContent
            title={`Revoke ${revoking.certificateNumber}?`}
            description={`For ${revoking.recipientName}. The number stays reserved and shows "revoked" on the verify page. Logged under your name.`}
            confirmLabel="Revoke"
            destructive
            loading={revokeBusy}
            onConfirm={revoke}
          >
            <Input placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
};
