"use client";

import * as React from "react";
import { toast } from "sonner";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useAuth } from "@/components/providers";
import { useFestEvents } from "@/components/admin/hooks";
import { PENDING_CLAIMS_NOTICE, useAssignMember, useMemberFests, useMembers, useMyAccess, useRevokeMember, useUpdateMember, type InviteSent, type MemberRow } from "@/components/admin/members-api";
import { CheckOption, Field, Input, NativeSelect } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { EmptyState, Kick, Note, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { ASSIGNABLE_ROLES, DUTIES, DUTY_LABELS, FEST_ROLE_LABELS, type AssignableRole, type Duty } from "@/core/models/membership";
import { ApiClientError } from "@/data/api-client";

/**
 * Team - the people who work on this main event, and what each may do.
 *
 * The Event Head assigns admins, coordinators and volunteers to any competition. An admin assigns volunteers to the
 * competitions they are assigned to themselves. Nobody changes their own role, and there is no way to add a second Event
 * Head from here: the server enforces all of that, and this screen only offers what the server will accept.
 */

const ROLE_HELP: Record<AssignableRole, string> = {
  admin: "Runs the competitions they are assigned: details, registrations, results, certificates. Nothing fest-wide.",
  coordinator: "Manages the competitions they are assigned: details, results and attendance.",
  volunteer: "Works the gate, the meal counters or match scoring at the competitions they are assigned.",
};

const STATUS_TONE = { active: "accent", suspended: "neutral", revoked: "danger" } as const;

export default function TeamPage() {
  const { fest } = useFest();
  const { session } = useAuth();
  const memberFests = useMemberFests();
  const governed = memberFests.ids.includes(fest.id);
  const access = useMyAccess(governed);
  const mine = access.data?.memberships.find((m) => m.festId === fest.id);
  const members = useMembers(fest.id);
  const events = useFestEvents(fest.id);

  // What this person may hand out. The server is the authority; this only avoids offering what it will refuse.
  const isHeadLike = mine ? mine.role === "head" : session?.role === "super_admin" || session?.uid === fest.ownerId;
  const ownEvents = mine && mine.role !== "head" ? mine.eventIds : null;
  const assignableEvents = (events.data ?? []).filter((e) => !ownEvents || ownEvents.includes(e.id));
  const assignableRoles: readonly AssignableRole[] = isHeadLike ? ASSIGNABLE_ROLES : ["volunteer"];

  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<MemberRow | null>(null);
  const [revoking, setRevoking] = React.useState<MemberRow | null>(null);
  const [invite, setInvite] = React.useState<{ email: string; result: InviteSent } | null>(null);
  const revoke = useRevokeMember(fest.id);
  const update = useUpdateMember(fest.id);

  const titleOf = React.useCallback((id: string) => events.data?.find((e) => e.id === id)?.title ?? "…", [events.data]);

  if (members.isPending || events.loading) {
    return (
      <AdminPage className="py-8">
        <Skeleton className="h-64" />
      </AdminPage>
    );
  }

  if (members.isError) {
    return (
      <AdminPage className="py-8">
        <EmptyState title="You can't manage the team here" body={members.error instanceof ApiClientError ? members.error.message : "Only the Event Head and the admins of a competition can."} />
      </AdminPage>
    );
  }

  const rows = members.data ?? [];

  return (
    <AdminPage className="py-8">
      <PageHeading
        kick="Team"
        title="Who works on this event"
        sub={isHeadLike ? "Assign admins, coordinators and volunteers to the competitions they run." : "Assign volunteers to the competitions you are assigned to."}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)} disabled={assignableEvents.length === 0}>
            Add someone
          </Button>
        }
      />

      {rows.length === 0 ? (
        <EmptyState className="mt-6" title="Nobody yet" body="Add the first person. They will get an email to set up their account." />
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {rows.map((member) => (
            <li key={member.userId} className="panel flex flex-wrap items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{member.name || member.email}</span>
                  <Tag tone={STATUS_TONE[member.status]}>{member.status === "active" ? FEST_ROLE_LABELS[member.role] : `${FEST_ROLE_LABELS[member.role]} · ${member.status}`}</Tag>
                </div>
                <div className="text-[12px] text-neutral-500">{member.email}</div>
                <div className="mt-1.5 text-[13px] text-neutral-400">
                  {member.role === "head" ? "The whole event" : member.eventIds.length === 0 ? "No competitions" : member.eventIds.map(titleOf).join(", ")}
                  {member.duties.length > 0 ? ` · ${member.duties.map((d) => DUTY_LABELS[d]).join(", ")}` : ""}
                </div>
              </div>
              {member.role !== "head" && member.status !== "revoked" && member.userId !== session?.uid ? (
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      update
                        .mutateAsync({ userId: member.userId, patch: { status: member.status === "active" ? "suspended" : "active" } })
                        .then((done) => (done.claimsSync ? toast.warning(PENDING_CLAIMS_NOTICE) : toast.success(member.status === "active" ? "Suspended" : "Reinstated")))
                        .catch((error) => toast.error(error instanceof ApiClientError ? error.message : "Couldn't update"))
                    }
                  >
                    {member.status === "active" ? "Suspend" : "Reinstate"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(member)}>
                    Edit
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setRevoking(member)}>
                    Revoke
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {invite ? (
        <Note title={`Share ${invite.email}'s sign-in`} className="mt-6">
          {invite.result.emailed ? "We emailed them. " : "Email isn't configured, so share this yourself. "}
          Temporary password (shown once): <code>{invite.result.temporaryPassword}</code>
        </Note>
      ) : null}

      <MemberDialog
        key={editing?.userId ?? (adding ? "new" : "closed")}
        open={adding || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAdding(false);
            setEditing(null);
          }
        }}
        festId={fest.id}
        member={editing}
        roles={assignableRoles}
        events={assignableEvents.map((e) => ({ id: e.id, title: e.title }))}
        onInvite={(email, result) => setInvite({ email, result })}
      />

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        {revoking ? (
          <AlertDialogContent
            title={`Revoke ${revoking.name || revoking.email}?`}
            description="They lose access to this event straight away. You can assign them again later."
            confirmLabel="Revoke access"
            destructive
            loading={revoke.isPending}
            onConfirm={async () => {
              try {
                const done = await revoke.mutateAsync(revoking.userId);
                if (done.claimsSync) toast.warning(PENDING_CLAIMS_NOTICE);
                else toast.success("Access revoked");
                setRevoking(null);
              } catch (error) {
                toast.error(error instanceof ApiClientError ? error.message : "Couldn't revoke");
              }
            }}
          />
        ) : null}
      </AlertDialog>
    </AdminPage>
  );
}

const MemberDialog = ({
  open,
  onOpenChange,
  festId,
  member,
  roles,
  events,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  festId: string;
  member: MemberRow | null;
  roles: readonly AssignableRole[];
  events: Array<{ id: string; title: string }>;
  onInvite: (email: string, result: InviteSent) => void;
}) => {
  const assign = useAssignMember(festId);
  const update = useUpdateMember(festId);
  const editing = member !== null;

  const [email, setEmail] = React.useState(member?.email ?? "");
  const [name, setName] = React.useState(member?.name ?? "");
  const [role, setRole] = React.useState<AssignableRole>((member?.role as AssignableRole | undefined) ?? roles[0] ?? "volunteer");
  const [eventIds, setEventIds] = React.useState<string[]>(member?.eventIds ?? []);
  const [duties, setDuties] = React.useState<Duty[]>(member?.duties ?? []);

  const toggle = <T extends string>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      if (editing) {
        const done = await update.mutateAsync({ userId: member.userId, patch: { role, eventIds, duties: role === "volunteer" ? duties : [] } });
        if (done.claimsSync) toast.warning(PENDING_CLAIMS_NOTICE);
        else toast.success("Updated");
      } else {
        const result = await assign.mutateAsync({ email, ...(name ? { name } : {}), role, eventIds, duties: role === "volunteer" ? duties : [] });
        if (result.invite) onInvite(email, result.invite);
        if (result.claimsSync) toast.warning(PENDING_CLAIMS_NOTICE);
        else toast.success("Added");
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : "Couldn't save");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={editing ? `Edit ${member.name || member.email}` : "Add someone to the team"} description={ROLE_HELP[role]} size="md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          {editing ? null : (
            <>
              <Field label="Email" htmlFor="tm-email">
                <Input id="tm-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Name (for a new account)" htmlFor="tm-name">
                <Input id="tm-name" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Role" htmlFor="tm-role">
            <NativeSelect id="tm-role" value={role} onChange={(e) => setRole(e.target.value as AssignableRole)} disabled={roles.length === 1}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {FEST_ROLE_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <fieldset className="flex flex-col gap-2">
            <Kick>Competitions</Kick>
            {events.length === 0 ? <span className="text-[13px] text-neutral-500">No competitions to assign yet.</span> : null}
            {events.map((e) => (
              <CheckOption key={e.id} label={e.title} checked={eventIds.includes(e.id)} onChange={() => setEventIds((current) => toggle(current, e.id))} />
            ))}
          </fieldset>
          {role === "volunteer" ? (
            <fieldset className="flex flex-col gap-2">
              <Kick>Duties</Kick>
              {DUTIES.map((d) => (
                <CheckOption key={d} label={DUTY_LABELS[d]} checked={duties.includes(d)} onChange={() => setDuties((current) => toggle(current, d))} />
              ))}
            </fieldset>
          ) : null}
          <DialogActions>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={assign.isPending || update.isPending || eventIds.length === 0 || (role === "volunteer" && duties.length === 0)}>
              {editing ? "Save" : "Add"}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
};
