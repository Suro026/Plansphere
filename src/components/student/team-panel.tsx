"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DotsThree } from "@phosphor-icons/react";
import { RepositoryError } from "@/core/models/common";
import { teamShortfall, type Registration, type TeamAction, type TeamMember } from "@/core/models/registration";
import type { Event } from "@/core/models/event";
import { useAuth, useRepositories } from "@/components/providers";
import type { Entry } from "@/components/student/use-my-entries";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { AlertDialog, AlertDialogContent, Avatar, Dialog, DialogActions, DialogContent, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { Kick, Note, Tag } from "@/components/ui/primitives";
import { formatCalendarDate } from "@/lib/utils";

const fail = (error: unknown, fallback: string) => toast.error(error instanceof RepositoryError ? error.message : fallback);

/** One mutation for every team change; the entries query is the single source it refreshes. */
export const useTeamAction = (registrationId: string) => {
  const repos = useRepositories();
  const qc = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: (input: TeamAction) => repos.registrations.teamAction(registrationId, input),
    onSuccess: (updated: Registration) => {
      qc.setQueryData<Entry[]>(["my-entries", session?.uid], (old) =>
        old ? old.map((e) => (e.registration.id === updated.id ? { ...e, registration: updated } : e)) : old,
      );
      void qc.invalidateQueries({ queryKey: ["my-entries", session?.uid] });
    },
  });
};

/* ───────────── invitation (teammate's view) ───────────── */

export const InvitationCard = ({ entry }: { entry: Entry }) => {
  const { registration, event, fest } = entry;
  const act = useTeamAction(registration.id);
  const leader = registration.members.find((m) => m.isLeader);
  const [busy, setBusy] = React.useState<"accept" | "decline" | null>(null);

  const respond = async (action: "accept" | "decline") => {
    setBusy(action);
    try {
      await act.mutateAsync({ action });
      toast.success(action === "accept" ? `You’re on ${registration.teamName}` : "Invitation declined");
    } catch (error) {
      fail(error, "Couldn’t update the invitation");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel p-3.5 shadow-[inset_3px_0_0_var(--color-accent)]">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[15px] font-medium">{registration.teamName}</div>
        <Tag tone="accent">Invitation</Tag>
      </div>
      <div className="mb-3 text-[12.5px] text-neutral-300">
        {leader?.name ?? registration.userName} added you · {registration.eventTitle}
        {event ? ` · ${formatCalendarDate(event.date)}` : ""}
        {fest ? ` · ${fest.name}` : ""}
      </div>
      <div className="mb-3 text-[12px] text-neutral-500">
        Accepting puts this event on your pass and makes you eligible for its certificate. Declining frees the seat for someone else.
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" loading={busy === "accept"} disabled={busy !== null} onClick={() => respond("accept")}>
          Accept
        </Button>
        <Button variant="secondary" size="sm" loading={busy === "decline"} disabled={busy !== null} onClick={() => respond("decline")}>
          Decline
        </Button>
      </div>
    </div>
  );
};

/* ───────────── team card (everyone's view; leader gets controls) ───────────── */

const memberTag = (m: TeamMember) =>
  m.isLeader ? (
    <Tag tone="outline">Leader</Tag>
  ) : m.inviteStatus === "pending" ? (
    <Tag tone="neutral">Invited</Tag>
  ) : m.userId ? (
    <Tag tone="neutral" check>
      Joined
    </Tag>
  ) : (
    <Tag tone="neutral" className="opacity-70">
      No account yet
    </Tag>
  );

export const TeamCard = ({ entry }: { entry: Entry }) => {
  const { registration, event, fest, attendance } = entry;
  const { session } = useAuth();
  const isLeader = session?.uid === registration.userId;
  const teamSize = event?.teamSize ?? { min: 1, max: registration.members.length };
  const shortfall = teamShortfall(registration, teamSize);
  const frozen = Boolean(attendance) || (event ? event.status === "ongoing" || event.status === "completed" || event.status === "cancelled" : false);
  const canEdit = isLeader && !frozen && registration.status !== "cancelled" && registration.status !== "pending_payment";

  return (
    <div className="panel p-3.5">
      <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="truncate text-[15px] font-medium">{registration.teamName}</div>
            {canEdit ? <RenameDialog registration={registration} /> : null}
          </div>
          <div className="text-[11.5px] text-neutral-500">
            {registration.eventTitle}
            {event ? ` · ${formatCalendarDate(event.date)}` : ""}
            {fest ? ` · ${fest.name}` : ""}
          </div>
        </div>
        <div className="flex gap-[7px]">
          {attendance ? (
            <Tag tone="accent" check>Checked in</Tag>
          ) : registration.status === "waitlisted" ? (
            <Tag tone="neutral">Waitlisted</Tag>
          ) : registration.status === "pending_payment" ? (
            <Tag tone="outline">Payment due</Tag>
          ) : registration.status === "draft" ? (
            <Tag tone="outline">Not confirmed yet</Tag>
          ) : (
            <Tag tone="accent">Confirmed</Tag>
          )}
          <Tag tone="outline">
            {registration.members.length}/{teamSize.max} members
          </Tag>
        </div>
      </div>

      {shortfall.missing > 0 || shortfall.pending > 0 ? (
        <div className="mb-3 text-[12px] text-accent-300">
          {shortfall.missing > 0 ? `Needs ${shortfall.missing} more member${shortfall.missing === 1 ? "" : "s"} — this event requires ${teamSize.min}. ` : ""}
          {shortfall.pending > 0 ? `${shortfall.pending} invitation${shortfall.pending === 1 ? "" : "s"} awaiting a reply.` : ""}
        </div>
      ) : null}

      {/* The code is the fast path: read it out, they type it, they are in.
          Hidden once the team is full, where it can do nothing. */}
      {canEdit && registration.joinCode && registration.members.length < teamSize.max ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-bg/40 px-3 py-2">
          <span className="text-[12px] text-neutral-500">Join code</span>
          <span className="font-mono text-[15px] tracking-[0.2em]">{registration.joinCode}</span>
          <button
            type="button"
            className="btn btn-ghost text-[12px]"
            onClick={() => {
              navigator.clipboard
                .writeText(registration.joinCode!)
                .then(() => toast.success("Code copied"))
                .catch(() => toast.error("Couldn't reach the clipboard — read it out instead."));
            }}
          >
            Copy
          </button>
          <span className="text-[11.5px] text-neutral-500">Anyone with it joins from Teams.</span>
        </div>
      ) : null}

      <Kick className="mb-2">Members</Kick>
      <div className="flex flex-col gap-2">
        {registration.members.map((m) => (
          <div key={m.email} className="flex items-center gap-2.5">
            <Avatar name={m.name} size={26} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">
                {m.name}
                {m.email === session?.email ? <span className="text-neutral-500"> · you</span> : null}
              </div>
              <div className="truncate text-[11px] text-neutral-500">{m.email}</div>
            </div>
            {memberTag(m)}
            {canEdit && !m.isLeader ? <RemoveMemberMenu registration={registration} member={m} /> : null}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link href={`/registered/${registration.id}`}>Team pass</Link>
        </Button>
        {canEdit && registration.members.length < teamSize.max ? <InviteDialog registration={registration} event={event} /> : null}
      </div>

      {!isLeader ? (
        <div className="mt-3 text-[12px] text-neutral-500">
          One ticket admits the whole team. {registration.members.find((m) => m.isLeader)?.name ?? "The leader"} manages who is on it.
        </div>
      ) : frozen ? (
        <div className="mt-3 text-[12px] text-neutral-500">The roster is locked: {attendance ? "the pass has been scanned" : "the event has started"}.</div>
      ) : registration.members.some((m) => !m.userId) ? (
        <div className="mt-3 text-[12px] text-neutral-500">
          Teammates without an account can still enter on this ticket, but their certificate is only issued once they sign up with the email above.
        </div>
      ) : null}
    </div>
  );
};

/* ───────────── leader controls ───────────── */

const RenameDialog = ({ registration }: { registration: Registration }) => {
  const act = useTeamAction(registration.id);
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(registration.teamName ?? "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await act.mutateAsync({ action: "rename", teamName: name.trim() });
      setOpen(false);
      toast.success("Team renamed");
    } catch (error) {
      fail(error, "Couldn’t rename the team");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setName(registration.teamName ?? ""); }}>
      <button type="button" className="btn btn-ghost btn-sm text-[12px]" onClick={() => setOpen(true)}>
        Rename
      </button>
      <DialogContent title="Rename team" description="Shown on the pass, the roster and every certificate issued to the team.">
        <form onSubmit={submit}>
          <Field label="Team name" htmlFor="team-name">
            <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <DialogActions>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={act.isPending} disabled={!name.trim() || name.trim() === registration.teamName}>
              Save
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const InviteDialog = ({ registration, event }: { registration: Registration; event: Event | null }) => {
  const act = useTeamAction(registration.id);
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!name.trim()) return setError("Enter their name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return setError("Enter a valid email");
    if (registration.members.some((m) => m.email === addr)) return setError("They’re already on the team");
    setError(null);
    try {
      await act.mutateAsync({ action: "invite", member: { name: name.trim(), email: addr } });
      setOpen(false);
      setName("");
      setEmail("");
      toast.success(`Invitation sent to ${addr}`);
    } catch (err) {
      fail(err, "Couldn’t add the teammate");
    }
  };

  const seatsLeft = event && event.capacity > 0 ? Math.max(0, event.capacity - event.registeredCount) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        Add member
      </Button>
      <DialogContent title="Add a teammate" description="They get an email and, if they have an account, a notification. A seat is held for them until they decline.">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Name" htmlFor="invite-name">
            <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Email" htmlFor="invite-email" error={error ?? undefined} hint={error ? undefined : "Use the address they sign in with, so the entry links to their account."}>
            <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" />
          </Field>
          {registration.status === "confirmed" && seatsLeft === 0 ? (
            <Note>This event is full. Adding a member needs a free seat.</Note>
          ) : null}
          <DialogActions>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={act.isPending}>
              Send invitation
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const RemoveMemberMenu = ({ registration, member }: { registration: Registration; member: TeamMember }) => {
  const act = useTeamAction(registration.id);
  const [confirm, setConfirm] = React.useState(false);

  const remove = async () => {
    try {
      await act.mutateAsync({ action: "remove", email: member.email });
      toast.success(`${member.name} removed`);
      setConfirm(false);
    } catch (error) {
      fail(error, "Couldn’t remove the teammate");
    }
  };

  return (
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Options for ${member.name}`}>
            <DotsThree size={18} weight="bold" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem destructive onSelect={() => setConfirm(true)}>
            Remove from team
          </MenuItem>
        </MenuContent>
      </Menu>
      <AlertDialogContent
        title={`Remove ${member.name}?`}
        description={`Their seat goes back to the pool and they lose access to the team pass. ${member.inviteStatus === "pending" ? "Their invitation is withdrawn." : "They’ll be notified."}`}
        confirmLabel="Remove"
        destructive
        loading={act.isPending}
        onConfirm={remove}
      />
    </AlertDialog>
  );
};
