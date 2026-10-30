"use client";

import * as React from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { useReleasePreview, usePublishCertificates } from "@/components/admin/platform-api";
import { useManagedFests } from "@/components/shell/admin-shell";
import { useRepositories } from "@/components/providers";
import { ImageUploadField } from "@/components/ui/image-upload";
import { Button } from "@/components/ui/button";
import { Field, NativeSelect } from "@/components/ui/field";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/overlays";
import { EmptyState, Kick, Note, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { CERTIFICATE_LABELS, type CertificateType } from "@/core/models/certificate";
import { formatCount } from "@/lib/utils";

/**
 * The release desk.
 *
 * Four steps, in the order the spec puts them: choose the artwork, choose the
 * event, choose who, publish. Everything before the last button is
 * reversible; the last button is not, which is why it states the count and
 * asks again.
 */
export default function CertificateReleasePage() {
  const fests = useManagedFests();
  const repos = useRepositories();

  const [festId, setFestId] = React.useState("");
  const [eventId, setEventId] = React.useState("");
  const [templateUrl, setTemplateUrl] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const events = useQuery({
    queryKey: ["release-events", festId],
    enabled: Boolean(festId),
    queryFn: async () => {
      const page = await repos.events.list({ festId, limit: 200 });
      // Only a completed event can issue a certificate that says the event
      // happened; the route refuses the rest anyway.
      return page.items.filter((event) => event.status === "completed");
    },
  });

  const preview = useReleasePreview(eventId || null);
  const publish = usePublishCertificates();

  // A new event means a new list; start with everyone not yet released ticked.
  React.useEffect(() => {
    if (!preview.data) return;
    setSelected(new Set(preview.data.recipients.filter((r) => !r.released && !r.revoked).map((r) => r.userId)));
    setTemplateUrl(preview.data.templateUrl ?? "");
  }, [preview.data]);

  const recipients = preview.data?.recipients ?? [];
  const pending = recipients.filter((r) => !r.released && !r.revoked);
  const chosen = recipients.filter((r) => selected.has(r.userId));

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const release = async () => {
    try {
      const result = await publish.mutateAsync({
        eventId,
        userIds: [...selected],
        ...(templateUrl ? { templateUrl } : {}),
      });
      toast.success(
        `Released ${formatCount(result.published)} certificate${result.published === 1 ? "" : "s"} · ${formatCount(result.emailed)} emailed${result.failed ? `, ${result.failed} failed` : ""}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't release the certificates");
    }
  };

  return (
    <>
      <PageHeading
        kick="Certificates"
        title="Release centre"
        sub="Admins prepare the list. Releasing — the email, the download, the public record — is yours."
        className="mb-5"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Fest" htmlFor="r-fest">
          <NativeSelect
            id="r-fest"
            value={festId}
            onChange={(event) => {
              setFestId(event.target.value);
              setEventId("");
            }}
          >
            <option value="">Choose a fest…</option>
            {(fests.data ?? []).map((fest) => (
              <option key={fest.id} value={fest.id}>
                {fest.name}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <Field label="Event" htmlFor="r-event" hint="Completed events only.">
          <NativeSelect id="r-event" value={eventId} disabled={!festId || events.isPending} onChange={(event) => setEventId(event.target.value)}>
            <option value="">{events.isPending && festId ? "Loading…" : "Choose an event…"}</option>
            {(events.data ?? []).map((event) => (
              <option key={event.id} value={event.id}>
                {event.title}
              </option>
            ))}
          </NativeSelect>
        </Field>

        {eventId ? (
          <ImageUploadField
            id="r-template"
            label="Certificate artwork"
            kind="certificateTemplate"
            ownerId={preview.data?.event.festId}
            aspect="1414/1000"
            value={templateUrl}
            onChange={setTemplateUrl}
            hint="Optional — A4 landscape. Blank uses the Plansphere design."
          />
        ) : null}
      </div>

      {festId && !events.isPending && (events.data ?? []).length === 0 ? (
        <Note title="Nothing to release yet" className="mt-5 max-w-[62ch]">
          Certificates can only be issued for an event marked <em>completed</em> — a certificate states that the event has ended, and once it is sent it cannot be unsent. Close the event from its settings page first.
        </Note>
      ) : null}

      {eventId ? (
        preview.isPending ? (
          <Skeleton className="mt-6 h-64" />
        ) : preview.isError || !preview.data ? (
          <EmptyState className="mt-6" title="Couldn't work out who is eligible" body="The eligibility pass reads registrations, attendance and the result sheet for this event. One of them could not be read." />
        ) : recipients.length === 0 ? (
          <EmptyState
            className="mt-6"
            title="Nobody is eligible"
            body="Certificates go to people whose attendance was scanned at the gate, plus anyone on the published result sheet. Neither produced a name for this event."
          />
        ) : (
          <>
            <div className="mb-3 mt-7 flex flex-wrap items-end justify-between gap-3">
              <div>
                <Kick className="mb-1">Recipients</Kick>
                <p className="text-[13px] text-neutral-400">
                  {formatCount(recipients.length)} eligible · {formatCount(recipients.length - pending.length)} already released · {formatCount(selected.size)} selected
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(pending.map((r) => r.userId)))}>
                  Select all pending
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="primary" disabled={selected.size === 0 || publish.isPending}>
                      Publish {selected.size > 0 ? formatCount(selected.size) : ""}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent
                    title={`Release ${formatCount(chosen.length)} certificate${chosen.length === 1 ? "" : "s"}?`}
                    description="Each recipient is emailed their certificate, it appears in their pass, and the number becomes publicly verifiable. A certificate cannot be un-sent — it can only be revoked afterwards, which leaves a record."
                    confirmLabel="Publish them"
                    loading={publish.isPending}
                    onConfirm={release}
                  />
                </AlertDialog>
              </div>
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-10">
                      <span className="sr-only">Select</span>
                    </th>
                    <th>Recipient</th>
                    <th>Certificate</th>
                    <th>Number</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.map((recipient) => (
                    <tr key={recipient.userId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(recipient.userId)}
                          onChange={() => toggle(recipient.userId)}
                          aria-label={`Select ${recipient.name}`}
                        />
                      </td>
                      <td>
                        {recipient.name}
                        <div className="truncate text-[11.5px] text-neutral-500">{recipient.email}</div>
                      </td>
                      <td>
                        {CERTIFICATE_LABELS[recipient.type as CertificateType] ?? recipient.type}
                        {recipient.teamName ? <div className="text-[11.5px] text-neutral-500">Team {recipient.teamName}</div> : null}
                      </td>
                      <td className="whitespace-nowrap font-mono text-[12px] text-neutral-400">{recipient.certificateNumber ?? "—"}</td>
                      <td className="whitespace-nowrap">
                        {recipient.revoked ? (
                          <Tag tone="neutral">Revoked</Tag>
                        ) : recipient.released ? (
                          <Tag tone="accent">Released</Tag>
                        ) : recipient.issued ? (
                          <Tag tone="outline">Prepared</Tag>
                        ) : (
                          <Tag tone="outline">Not issued</Tag>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.data.unmatched.length > 0 ? (
              <Note title={`${preview.data.unmatched.length} eligible ${preview.data.unmatched.length === 1 ? "person has" : "people have"} no account`} className="mt-5 max-w-[68ch]">
                They were entered as teammates by email and never signed up, so there is nowhere to deliver a certificate. They appear the moment they create an account with the same address — re-run this then.
              </Note>
            ) : null}
          </>
        )
      ) : null}
    </>
  );
}
