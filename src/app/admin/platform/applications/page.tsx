"use client";

import * as React from "react";
import { toast } from "sonner";
import { fetchApplicationDocument, useApplications, useDecideApplication, type ApplicationRow } from "@/components/admin/applications-api";
import { Button } from "@/components/ui/button";
import { Field, Seg, Textarea } from "@/components/ui/field";
import { AlertDialog, AlertDialogContent, Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { EmptyState, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { VERIFICATION_STATUSES, type VerificationStatus } from "@/core/models/fest";
import { ApiClientError } from "@/data/api-client";
import { formatRelative } from "@/lib/utils";

/**
 * Event applications — where the platform team decides who may run an event.
 *
 * A self-service application creates a draft that carries no access. Approving it makes the applicant the Event Head of
 * that one event; rejecting it records a reason they can read and grants nothing. The server holds every rule (single
 * winner, not your own application, a verified address); this screen only shows the queue and sends the decision.
 */

const LABEL: Record<VerificationStatus, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected" };

export default function ApplicationsPage() {
  const [status, setStatus] = React.useState<VerificationStatus>("pending");
  const applications = useApplications(status);
  const decide = useDecideApplication();
  const [approving, setApproving] = React.useState<ApplicationRow | null>(null);
  const [rejecting, setRejecting] = React.useState<ApplicationRow | null>(null);
  const [reason, setReason] = React.useState("");

  const openDocument = async (row: ApplicationRow) => {
    try {
      const { url } = await fetchApplicationDocument(row.festId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : "Couldn't open the document");
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-8 lg:px-8">
      <PageHeading kick="Applications" title="Who may run an event" sub="Approve an application to make the applicant the Event Head of that one event. Rejecting records a reason they can read." />

      <div className="mt-5">
        <Seg
          aria-label="Application status"
          value={status}
          onChange={setStatus}
          options={VERIFICATION_STATUSES.map((value) => ({ value, label: LABEL[value] }))}
        />
      </div>

      {applications.isPending ? (
        <Skeleton className="mt-6 h-40" />
      ) : applications.isError ? (
        <EmptyState className="mt-6" title="Couldn't load the applications" body={applications.error instanceof ApiClientError ? applications.error.message : "Try again in a moment."} />
      ) : applications.data.length === 0 ? (
        <EmptyState className="mt-6" title={`No ${LABEL[status].toLowerCase()} applications`} body={status === "pending" ? "Nothing is waiting for a decision." : "Nothing here yet."} />
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {applications.data.map((row) => (
            <li key={row.festId} className="panel flex flex-wrap items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  <Tag tone={status === "approved" ? "accent" : status === "rejected" ? "danger" : "neutral"}>{LABEL[status]}</Tag>
                </div>
                <div className="text-[13px] text-neutral-400">
                  {row.organizationName}
                  {row.organizationType ? ` · ${row.organizationType}` : ""}
                  {row.city ? ` · ${row.city}` : ""}
                  {row.state ? `, ${row.state}` : ""}
                </div>
                <div className="mt-1.5 text-[13px]">
                  Applicant: {row.applicant.name || "—"} {row.applicant.email ? <span className="text-neutral-500">({row.applicant.email})</span> : null}{" "}
                  <Tag tone={row.applicant.emailVerified ? "accent" : "danger"}>{row.applicant.emailVerified ? "Email verified" : "Email not verified"}</Tag>
                </div>
                <div className="mt-1 text-[12px] text-neutral-500">
                  {row.submittedAt ? `Submitted ${formatRelative(new Date(row.submittedAt))}` : "Submission time unknown"}
                  {row.hasIdentityDocument ? " · identity document attached" : " · no identity document"}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {row.hasIdentityDocument ? (
                  <Button variant="secondary" size="sm" onClick={() => openDocument(row)}>
                    View ID document
                  </Button>
                ) : null}
                {status === "pending" ? (
                  <>
                    <Button variant="primary" size="sm" onClick={() => setApproving(row)} disabled={!row.applicant.emailVerified} title={row.applicant.emailVerified ? undefined : "The applicant has not verified their email address yet"}>
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setReason("");
                        setRejecting(row);
                      }}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={approving !== null} onOpenChange={(open) => !open && setApproving(null)}>
        {approving ? (
          <AlertDialogContent
            title={`Approve ${approving.name}?`}
            description={`${approving.applicant.name || "The applicant"} becomes the Event Head of this event, and only this event. You can't undo it from here.`}
            confirmLabel="Approve"
            loading={decide.isPending}
            onConfirm={async () => {
              try {
                await decide.mutateAsync({ festId: approving.festId, action: "approve" });
                toast.success("Approved");
                setApproving(null);
              } catch (error) {
                toast.error(error instanceof ApiClientError ? error.message : "Couldn't approve");
              }
            }}
          />
        ) : null}
      </AlertDialog>

      <Dialog open={rejecting !== null} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent title={rejecting ? `Reject ${rejecting.name}` : "Reject"} description="The applicant sees this reason and nothing is granted. Leave out email addresses and phone numbers.">
          <form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!rejecting) return;
              try {
                await decide.mutateAsync({ festId: rejecting.festId, action: "reject", reason });
                toast.success("Rejected");
                setRejecting(null);
              } catch (error) {
                toast.error(error instanceof ApiClientError ? error.message : "Couldn't reject");
              }
            }}
          >
            <Field label="Reason" htmlFor="app-reason">
              <Textarea id="app-reason" required minLength={3} maxLength={300} rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <DialogActions>
              <Button type="button" variant="secondary" onClick={() => setRejecting(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={decide.isPending || reason.trim().length < 3}>
                Reject application
              </Button>
            </DialogActions>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
