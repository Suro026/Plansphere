"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/data/api-client";
import { Button } from "@/components/ui/button";
import { Seg } from "@/components/ui/field";
import { Kick, Note, Skeleton, Tag } from "@/components/ui/primitives";
import { formatRelative } from "@/lib/utils";

interface EmailLogEntry {
  id: string;
  to: string;
  subject: string;
  template: string;
  status: "sent" | "failed" | "skipped";
  attempts: number;
  error: string | null;
  createdAt: string;
}

interface EmailLogResponse {
  provider: { name: string; canSend: boolean };
  counts: { sent: number; failed: number; skipped: number };
  entries: EmailLogEntry[];
}

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "sent", label: "Sent" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
];

/**
 * The delivery log for one fest: every email the server tried to send,
 * with provider, attempts and the error when it failed. This is where
 * "I never got it" is answered.
 */
export const EmailLog = ({ festId }: { festId: string }) => {
  const [status, setStatus] = React.useState("");
  const log = useQuery({
    queryKey: ["email-log", festId, status],
    queryFn: () => api<EmailLogResponse>(`/api/admin/email-log?festId=${festId}${status ? `&status=${status}` : ""}&limit=100`),
    refetchInterval: 30_000,
  });

  const data = log.data;

  return (
    <section className="mt-[26px]">
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <Kick>Email delivery</Kick>
          <div className="mt-[3px] text-[12.5px] text-neutral-500">
            {data ? `${data.counts.sent} sent · ${data.counts.failed} failed · ${data.counts.skipped} skipped · provider ${data.provider.name}` : "Loading…"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Seg options={STATUS_OPTIONS} value={status} onChange={setStatus} aria-label="Filter by status" />
          <Button variant="ghost" size="sm" onClick={() => void log.refetch()} loading={log.isFetching}>
            Refresh
          </Button>
        </div>
      </div>

      {data && !data.provider.canSend ? (
        <Note className="mb-3" title="No email provider is configured">
          Deliveries are being logged as <em>skipped</em>. Set <code className="code">EMAIL_PROVIDER=resend</code> and <code className="code">RESEND_API_KEY</code> on the server to start sending.
        </Note>
      ) : null}

      {log.isPending ? (
        <Skeleton className="h-40" />
      ) : !data || data.entries.length === 0 ? (
        <div className="text-[12.5px] text-neutral-500">Nothing sent for this fest yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>Template</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{formatRelative(new Date(e.createdAt))}</td>
                  <td className="max-w-[220px] truncate">{e.to}</td>
                  <td className="whitespace-nowrap">{e.template.replace(/_/g, " ")}</td>
                  <td>{e.status === "sent" ? <Tag tone="accent">Sent</Tag> : e.status === "failed" ? <Tag tone="danger">Failed</Tag> : <Tag tone="neutral">Skipped</Tag>}</td>
                  <td className="max-w-[320px] truncate text-neutral-500" title={e.error ?? e.subject}>
                    {e.error ?? e.subject}
                    {e.attempts > 1 ? ` · ${e.attempts} attempts` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
