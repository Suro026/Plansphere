"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { Fest } from "@/core/models/fest";
import { FEST_TYPE_LABELS, type FestType } from "@/core/models/fest";
import { useDeleteFest, useFestAction } from "@/components/admin/platform-api";
import { RegistrationFieldsEditor } from "@/components/admin/registration-fields-editor";
import { useStaff } from "@/components/admin/staff-api";
import { useManagedFests } from "@/components/shell/admin-shell";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/field";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger, Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { EmptyState, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { formatCount, formatDateRange } from "@/lib/utils";

/**
 * Global fest control.
 *
 * Everything on the platform, and the four verbs that belong to nobody else:
 * archive, reopen, transfer, delete. Editing a fest's own details still
 * happens in its settings page — this is the list, not a second editor.
 */
export default function PlatformFestsPage() {
  const fests = useManagedFests();
  const action = useFestAction();
  const remove = useDeleteFest();

  const [configuring, setConfiguring] = React.useState<Fest | null>(null);
  const [transferring, setTransferring] = React.useState<Fest | null>(null);

  const rows = (fests.data ?? []).slice().sort((a, b) => b.startDate.localeCompare(a.startDate));
  const today = new Date().toISOString().slice(0, 10);

  const run = async (label: string, work: Promise<unknown>) => {
    try {
      await work;
      toast.success(label);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn't work");
    }
  };

  return (
    <>
      <PageHeading
        kick="Fests"
        title="Every fest on the platform"
        sub={`${rows.length} total`}
        actions={
          <Button asChild variant="primary">
            <Link href="/admin/fests/new">Create a fest</Link>
          </Button>
        }
        className="mb-5"
      />

      {fests.isPending ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No fests yet"
          body="A fest is the container: events belong to it, staff are scoped to it, certificates carry its name. Create the first one and everything else follows."
          action={
            <Button asChild variant="primary">
              <Link href="/admin/fests/new">Create a fest</Link>
            </Button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fest</th>
                <th>Kind</th>
                <th>Dates</th>
                <th>Events</th>
                <th>Registrations</th>
                <th>Status</th>
                <th>Registration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((fest) => {
                const live = fest.status === "published" && fest.startDate <= today && fest.endDate >= today;
                const archived = fest.status === "archived";

                return (
                  <tr key={fest.id}>
                    <td>
                      <Link href={`/admin/${fest.slug}/overview`} className="text-inherit no-underline hover:text-accent">
                        {fest.name}
                      </Link>
                      <div className="font-mono text-[11px] text-neutral-500">/f/{fest.slug}</div>
                    </td>
                    <td className="whitespace-nowrap text-neutral-400">
                      {FEST_TYPE_LABELS[(fest.festType ?? "other") as FestType]}
                      {fest.academicYear ? <div className="text-[11.5px] text-neutral-500">{fest.academicYear}</div> : null}
                    </td>
                    <td className="whitespace-nowrap">{formatDateRange(fest.startDate, fest.endDate)}</td>
                    <td>{formatCount(fest.stats.events)}</td>
                    <td>{formatCount(fest.stats.registrations)}</td>
                    <td className="whitespace-nowrap">
                      {live ? (
                        <Tag tone="accent">Live</Tag>
                      ) : archived ? (
                        <Tag tone="neutral">Archived</Tag>
                      ) : fest.status === "published" ? (
                        <Tag tone="neutral">Published</Tag>
                      ) : (
                        <Tag tone="outline">Draft</Tag>
                      )}
                      {fest.visibility && fest.visibility !== "public" ? (
                        <div className="text-[11.5px] text-neutral-500">{fest.visibility}</div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap">
                      {(fest.registrationState ?? "open") === "open" ? (
                        <Tag tone="accent">Open</Tag>
                      ) : (fest.registrationState ?? "open") === "upcoming" ? (
                        <Tag tone="outline">Soon</Tag>
                      ) : (
                        <Tag tone="neutral">Closed</Tag>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <button type="button" className="btn btn-ghost text-[12px]" onClick={() => setConfiguring(fest)}>
                        Fields
                      </button>
                      <button type="button" className="btn btn-ghost text-[12px]" onClick={() => setTransferring(fest)}>
                        Transfer
                      </button>
                      {archived ? (
                        <button
                          type="button"
                          className="btn btn-ghost text-[12px]"
                          onClick={() => run(`${fest.name} reopened as a draft`, action.mutateAsync({ id: fest.id, action: "reopen", status: "draft" }))}
                        >
                          Reopen
                        </button>
                      ) : (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <button type="button" className="btn btn-ghost text-[12px]">
                              Archive
                            </button>
                          </AlertDialogTrigger>
                          <AlertDialogContent
                            title={`Archive ${fest.name}?`}
                            description="It leaves the explorer and stops taking registrations. Everything already issued — tickets, certificates, the public pages for them — keeps working, and you can reopen it at any time."
                            confirmLabel="Archive it"
                            onConfirm={() => run(`${fest.name} archived`, action.mutateAsync({ id: fest.id, action: "archive" }))}
                          />
                        </AlertDialog>
                      )}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button type="button" className="btn btn-ghost text-[12px] text-danger">
                            Delete
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent
                          title={`Delete ${fest.name}?`}
                          description="Permanent, and only possible while nothing points at the fest. If it has events, registrations or certificates the server will refuse and tell you to archive instead."
                          confirmLabel="Delete it"
                          destructive
                          onConfirm={() => run(`${fest.name} deleted`, remove.mutateAsync(fest.id))}
                        />
                      </AlertDialog>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={configuring !== null} onOpenChange={(open) => !open && setConfiguring(null)}>
        {configuring ? (
          <DialogContent title={`What ${configuring.name} asks for`} description="Applies to every event in this fest." size="lg">
            <RegistrationFieldsEditor
              initial={configuring.registrationFields}
              onSave={(fields) => action.mutateAsync({ id: configuring.id, action: "registrationFields", fields }).then(() => undefined)}
              onDone={() => setConfiguring(null)}
            />
          </DialogContent>
        ) : null}
      </Dialog>

      {transferring ? <TransferDialog fest={transferring} onClose={() => setTransferring(null)} /> : null}
    </>
  );
}

/**
 * Handing a fest to another admin. The new owner is granted the scope that
 * goes with it by the server — ownership without access is a broken state,
 * and making the super admin remember that separately is how it happens.
 */
const TransferDialog = ({ fest, onClose }: { fest: Fest; onClose: () => void }) => {
  const staff = useStaff();
  const action = useFestAction();
  const [ownerId, setOwnerId] = React.useState(fest.ownerId ?? "");

  const candidates = (staff.data ?? []).filter((row) => (row.role === "admin" || row.role === "super_admin") && !row.disabled);

  const submit = async () => {
    try {
      await action.mutateAsync({ id: fest.id, action: "transfer", ownerId });
      toast.success("Ownership transferred");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't transfer the fest");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={`Transfer ${fest.name}`} description="The new owner is the admin accountable for this fest. They are given access to it if they did not already have it.">
        <NativeSelect value={ownerId} onChange={(event) => setOwnerId(event.target.value)} aria-label="New owner">
          <option value="">Choose an admin…</option>
          {candidates.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name || row.email} · {row.role === "super_admin" ? "Super admin" : "Admin"}
            </option>
          ))}
        </NativeSelect>

        <DialogActions>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={action.isPending} disabled={!ownerId || ownerId === fest.ownerId}>
            Transfer
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
};
