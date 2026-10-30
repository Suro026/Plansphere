"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShareNetwork, DownloadSimple } from "@phosphor-icons/react";
import { Page } from "@/components/shell/student-shell";
import { useAuth, useRepositories } from "@/components/providers";
import { bucketEntries, useMyEntries } from "@/components/student/use-my-entries";
import { AnimatedList, Artwork, EmptyState, Skeleton } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { CERTIFICATE_LABELS, type Certificate } from "@/core/models/certificate";
import { formatCalendarDate } from "@/lib/utils";

/**
 * 3d — Certificates. Issued ones with preview, share and download; attended
 * events still waiting show dimmed with the reason. Someone who was not
 * eligible sees nothing here for that event at all.
 */
export default function CertificatesPage() {
  const { session } = useAuth();
  const repos = useRepositories();
  const { entries } = useMyEntries();
  const { attended } = bucketEntries(entries);

  const certificates = useQuery({
    queryKey: ["my-certificates", session?.uid],
    enabled: Boolean(session),
    queryFn: () => repos.certificates.listForUser(session!.uid),
  });

  const issuedEventIds = new Set((certificates.data ?? []).map((c) => c.eventId));
  const pending = attended.filter((e) => !issuedEventIds.has(e.registration.eventId));

  return (
    <Page className="max-w-[720px] pb-8 pt-2">
      <h4 className="mb-3">Certificates</h4>

      {certificates.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[220px]" />
          <Skeleton className="h-16" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatedList stagger={50} maxDelay={300} className="flex flex-col gap-3">
            {(certificates.data ?? []).map((c, i) => (
              <CertificateCard key={c.id} certificate={c} featured={i === 0} />
            ))}

            {pending.map((e) => (
              <div key={e.registration.id} className="panel p-3.5 opacity-70">
                <div className="text-[14px] font-medium">{e.registration.eventTitle}</div>
                <div className="mt-1 text-[11.5px] text-neutral-500">
                  {e.event && e.event.status === "completed"
                    ? "Attendance confirmed · certificate being issued"
                    : "Available after the event ends and entry is confirmed"}
                </div>
              </div>
            ))}
          </AnimatedList>

          {!certificates.data?.length && pending.length === 0 ? (
            <EmptyState
              title="No certificates yet"
              body="Attend an event — your QR gets scanned at the gate — and once it ends the college issues your certificate here and by email."
            />
          ) : null}

          <div className="px-0.5 py-1 text-[12px] text-neutral-500">
            Anyone with the link can verify these — no Plansphere account needed.
          </div>
        </div>
      )}
    </Page>
  );
}

const CertificateCard = ({ certificate: c, featured }: { certificate: Certificate; featured: boolean }) => {
  const verifyUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/verify/${c.certificateNumber}`;
  const label = CERTIFICATE_LABELS[c.type].replace("Certificate of ", "").replace("Excellence — ", "");

  const share = async () => {
    const data = { title: `${label} — ${c.eventTitle}`, text: `My ${label} for ${c.eventTitle} at ${c.festName}`, url: verifyUrl };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(verifyUrl);
        toast.success("Verify link copied");
      }
    } catch {
      /* user dismissed the share sheet */
    }
  };

  return (
    <div className="panel overflow-hidden">
      {featured ? (
        c.fileUrl ? (
          <Artwork src={undefined} label="certificate preview" className="h-[118px] items-center justify-center" />
        ) : (
          <Artwork label="certificate preview" className="h-[118px] items-center justify-center" />
        )
      ) : null}
      <div className="px-3.5 pb-3.5 pt-[13px]">
        <div className="text-[14px] font-medium">{c.eventTitle}</div>
        <div className="mb-[9px] mt-1 text-[11.5px] text-neutral-500">
          {label} · {c.certificateNumber} · issued {formatCalendarDate(c.issuedAt.toISOString().slice(0, 10))}
        </div>
        <div className="flex gap-2">
          <Button variant="primary" size="sm" className="flex-1" onClick={share}>
            <ShareNetwork size={14} /> Share
          </Button>
          {c.fileUrl ? (
            <a href={c.fileUrl} className="btn btn-secondary btn-sm flex-1" target="_blank" rel="noreferrer">
              <DownloadSimple size={14} /> Download
            </a>
          ) : (
            <Button variant="secondary" size="sm" className="flex-1" disabled>
              PDF on its way
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
