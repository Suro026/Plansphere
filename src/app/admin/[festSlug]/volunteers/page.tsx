"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useAuth, useRepositories } from "@/components/providers";
import { useFestAudit, useFestEvents, useFestGateFeed, useFestShifts } from "@/components/admin/hooks";
import { useFestArenas } from "@/components/live/hooks";
import { useCreateStaff, useResendInvite, useStaff, useUpdateStaff, type InviteResult, type StaffRow } from "@/components/admin/staff-api";
import { Seg, Field, Input, RadioOption, CheckOption, Textarea } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { AnimatedList, EmptyState, Kick, Kpi, KpiStrip, MetaList, MetaRow, Note, PageHeading, Skeleton, Table, Tag, Timeline, TimelineItem } from "@/components/ui/primitives";
import { SHIFT_DUTY_LABELS, shiftPhase, type Shift, type ShiftDuty } from "@/core/models/shift";
import { calendarDateSchema, clockTimeSchema, emailSchema, phoneSchema, shortTextSchema } from "@/core/models/common";
import { ApiClientError } from "@/data/api-client";
import { RepositoryError } from "@/core/models/common";
import { formatCalendarDate, formatClock, formatRelative } from "@/lib/utils";

const createSchema = z.object({
  name: shortTextSchema,
  email: emailSchema,
  phone: z.union([phoneSchema, z.literal("")]).optional(),
  duty: z.enum(["entry", "meal", "crowd"]),
  post: shortTextSchema,
  date: calendarDateSchema,
  startTime: clockTimeSchema,
  endTime: clockTimeSchema,
  eventIds: z.array(z.string()),
  notes: z.string().trim().max(2000).optional(),
});
type CreateValues = z.input<typeof createSchema>;

type Filter = "all" | "on" | "unassigned" | "pending";

/**
 * 5b — Volunteer management. The roster by post and shift, live scan counts
 * per volunteer, post coverage for the next four hours, and the create panel
 * that issues an volunteer account pre-set to a duty.
 */
export default function VolunteersPage() {
  const { fest } = useFest();
  const events = useFestEvents(fest.id);
  const shifts = useFestShifts(fest.id);
  const staff = useStaff();
  const feed = useFestGateFeed(fest.id, 5000);
  const audit = useFestAudit(fest.id, 30);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const [invite, setInvite] = React.useState<{ email: string; result: InviteResult } | null>(null);
  const [editing, setEditing] = React.useState<Shift | null>(null);
  const arenas = useFestArenas(fest.id);
  const arenaNames = React.useMemo(() => new Map((arenas.data ?? []).map((a) => [a.id, a.name])), [arenas.data]);
  // A scoring shift's `post` is an arena id; show the arena's name.
  const postLabel = React.useCallback((s: Shift) => (s.duty === "scoring" ? (arenaNames.get(s.post) ?? "Arena") : s.post), [arenaNames]);

  // One clock reading per render pass; the live subscriptions re-render anyway.
  const now = React.useMemo(() => new Date(), [shifts.data, feed.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = now.toISOString().slice(0, 10);
  const staffById = React.useMemo(() => new Map((staff.data ?? []).map((s) => [s.id, s])), [staff.data]);

  // Scans today, by scanner.
  const scansBy = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const a of feed.data ?? []) {
      if (a.scannedAt.toISOString().slice(0, 10) !== today) continue;
      m.set(a.scannedBy, (m.get(a.scannedBy) ?? 0) + 1);
    }
    return m;
  }, [feed.data, today]);

  const all = React.useMemo(() => shifts.data ?? [], [shifts.data]);
  const volunteers = new Set(all.map((s) => s.userId));
  const onNow = all.filter((s) => shiftPhase(s, now) === "active");
  const scansToday = [...scansBy.values()].reduce((a, b) => a + b, 0);

  // Posts named on today's events, and who covers them in the next 4 hours.
  const coverage = React.useMemo(() => {
    const posts = new Map<string, { needed: number; have: number }>();
    for (const e of events.data ?? []) {
      if (e.date !== today) continue;
      for (const g of e.gates) posts.set(g, { needed: (posts.get(g)?.needed ?? 0) + 1, have: posts.get(g)?.have ?? 0 });
    }
    const horizon = new Date(now.getTime() + 4 * 3600_000);
    for (const s of all) {
      // A scoring shift's `post` is an arena id, not a gate — it has no entry in the gate coverage list.
      if (s.cancelled || s.date !== today || s.duty === "scoring") continue;
      const start = new Date(`${s.date}T${s.startTime}:00`);
      const end = new Date(`${s.date}T${s.endTime}:00`);
      if (end < now || start > horizon) continue;
      const entry = posts.get(s.post) ?? { needed: 1, have: 0 };
      entry.have += 1;
      posts.set(s.post, entry);
    }
    return [...posts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [events.data, all, now, today]);

  const rows = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return all
      .filter((s) => {
        const phase = shiftPhase(s, now);
        const st = staffById.get(s.userId);
        if (filter === "on") return phase === "active";
        if (filter === "unassigned") return !s.post;
        if (filter === "pending") return st ? !st.activated : false;
        return true;
      })
      .filter((s) => !term || s.userName.toLowerCase().includes(term) || s.userEmail.toLowerCase().includes(term) || postLabel(s).toLowerCase().includes(term))
      .sort((a, b) => {
        const pa = shiftPhase(a, now);
        const pb = shiftPhase(b, now);
        const order = { active: 0, upcoming: 1, completed: 2, cancelled: 3 };
        return order[pa] - order[pb] || `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`);
      });
  }, [all, filter, search, staffById, now, postLabel]);

  const eventTitle = (ids: string[]) => (ids.length === 0 ? "Whole fest" : ids.map((id) => (events.data ?? []).find((e) => e.id === id)?.title ?? "…").join(", "));

  return (
    <>
      <AdminPage className="pb-[18px] pt-[26px]">
        <PageHeading
          title="Volunteers"
          sub={`${volunteers.size} volunteer accounts rostered by post · ${onNow.length} on shift now · created by an admin, never self sign-up`}
        />
      </AdminPage>

      <KpiStrip className="mx-auto w-full max-w-[1180px]">
        <AnimatedList stagger={35} className="flex">
          <Kpi value={volunteers.size} label="Volunteers" />
          <Kpi value={onNow.length} label="On shift now" />
          <Kpi value={coverage.filter(([, c]) => c.have === 0).length} label="Posts unstaffed" />
          <Kpi value={scansToday} label="Scans today" />
          <Kpi value={all.filter((s) => s.date === today && !s.cancelled).length} label="Shifts today" />
        </AnimatedList>
      </KpiStrip>

      <AdminPage className="grid gap-9 pb-9 pt-6 lg:grid-cols-[1fr_356px]">
        <div className="min-w-0">
          <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
            <Seg
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All ${all.length}` },
                { value: "on", label: "On shift" },
                { value: "unassigned", label: "Unassigned" },
                { value: "pending", label: "Not activated" },
              ]}
              aria-label="Filter volunteers"
            />
            <Input type="search" placeholder="Search name or post" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-[210px]" aria-label="Search volunteers" />
          </div>

          {shifts.loading ? (
            <Skeleton className="h-56" />
          ) : rows.length === 0 ? (
            <EmptyState title={all.length ? "Nothing matches" : "No shifts yet"} body={all.length ? "Try another filter." : "Create a volunteer on the right — the account and their first shift in one go."} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Volunteer</th>
                  <th>Post & duty</th>
                  <th>Shift</th>
                  <th>Scans</th>
                  <th>Events</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <AnimatedList as="tbody" variant="fade">
                {rows.map((s) => {
                    const phase = shiftPhase(s, now);
                    const st = staffById.get(s.userId);
                    const scans = scansBy.get(s.userId) ?? 0;
                    return (
                      <tr key={s.id}>
                        <td>
                          <div>{s.userName}</div>
                          <div className="text-[11.5px] text-neutral-500">{s.userEmail}</div>
                        </td>
                        <td>
                          {s.post ? postLabel(s) : <span className="text-neutral-500">Unassigned</span>} · {SHIFT_DUTY_LABELS[s.duty].split(" ")[0]!.toLowerCase()}
                        </td>
                        <td className="whitespace-nowrap">
                          {s.date === today ? "" : `${formatCalendarDate(s.date)} · `}
                          {s.startTime}–{s.endTime}
                        </td>
                        <td>{s.duty === "crowd" ? "—" : scans}</td>
                        <td className="max-w-[160px] truncate">{eventTitle(s.eventIds)}</td>
                        <td>
                          {st && !st.activated ? <Tag tone="neutral">Not activated</Tag> : s.cancelled ? <Tag tone="neutral">Cancelled</Tag> : phase === "active" ? <Tag tone="accent">On shift</Tag> : phase === "upcoming" ? <Tag tone="neutral">Upcoming</Tag> : (
                            <Tag tone="neutral">Completed{scans ? ` · ${scans}` : ""}</Tag>
                          )}
                        </td>
                        <td className="text-right">
                          <button type="button" className="btn btn-ghost text-[12px]" onClick={() => setEditing(s)}>
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </AnimatedList>
            </Table>
          )}

          <div className="mt-[26px] grid gap-[22px] sm:grid-cols-2">
            <div>
              <Kick className="mb-2.5">Post coverage · next 4 hours</Kick>
              {coverage.length === 0 ? (
                <div className="text-[12.5px] text-neutral-500">No gates named on today’s events. Add gates under an event’s Scanning & meals.</div>
              ) : (
                <MetaList>
                  {coverage.map(([post, c]) => (
                    <MetaRow key={post} label={post} emphasis={c.have === 0}>
                      {c.have} of {Math.max(c.needed, c.have)}
                      {c.have === 0 ? " · unstaffed" : c.have < c.needed ? " · short" : ""}
                    </MetaRow>
                  ))}
                </MetaList>
              )}
            </div>
            <div>
              <Kick className="mb-2.5">Volunteer activity</Kick>
              {audit.loading ? (
                <Skeleton className="h-24" />
              ) : (
                <Timeline>
                  {(feed.data ?? []).slice(0, 2).map((a, i) => (
                    <TimelineItem key={a.id} title={`${a.scannedByName ?? "A volunteer"} scanned ${a.userName}`} meta={`${formatClock(a.scannedAt)}${a.gate ? ` · ${a.gate}` : ""}`} live={i === 0} />
                  ))}
                  {(audit.data ?? [])
                    .filter((e) => e.action.startsWith("staff_") || e.action.startsWith("shift_"))
                    .slice(0, 3)
                    .map((e) => (
                      <TimelineItem key={e.id} title={e.summary} meta={`${formatRelative(e.createdAt)} · by ${e.actorName.split(/\s+/)[0]}`} />
                    ))}
                  {(feed.data?.length ?? 0) === 0 && (audit.data?.length ?? 0) === 0 ? <div className="text-[12.5px] text-neutral-500">Nothing yet.</div> : null}
                </Timeline>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3.5">
          <CreateVolunteerCard onInvited={setInvite} />
          <Note title="One-time link, same as any staff account">
            The server creates the account and emails a link valid one hour; the volunteer sets their own password on first sign-in.
            Disabling the account revokes access without deleting scan history.
          </Note>
        </div>
      </AdminPage>

      {editing ? <EditShiftDialog shift={editing} staff={staffById.get(editing.userId)} onClose={() => setEditing(null)} onInvite={setInvite} /> : null}

      <Dialog open={invite !== null} onOpenChange={(o) => !o && setInvite(null)}>
        {invite ? (
          <DialogContent title={invite.result.emailed ? "Invitation sent" : "Pass this link on"} description={invite.email}>
            {invite.result.emailed ? (
              <div className="text-[13.5px] text-neutral-300">Their password-set link is on its way.</div>
            ) : (
              <>
                <div className="text-[13.5px] text-neutral-300">No email provider yet — copy the link and send it yourself. Single-use, expires.</div>
                <div className="code break-all rounded-md bg-bg p-3 text-[11.5px] tracking-normal">{invite.result.setPasswordLink}</div>
                <DialogActions>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      await navigator.clipboard.writeText(invite.result.setPasswordLink ?? "");
                      toast.success("Link copied");
                    }}
                  >
                    Copy link
                  </Button>
                </DialogActions>
              </>
            )}
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

const CreateVolunteerCard = ({ onInvited }: { onInvited: (i: { email: string; result: InviteResult }) => void }) => {
  const { fest } = useFest();
  const { session } = useAuth();
  const repos = useRepositories();
  const events = useFestEvents(fest.id);
  const staff = useStaff();
  const create = useCreateStaff();
  const today = new Date().toISOString().slice(0, 10);
  const [again, setAgain] = React.useState(false);

  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", email: "", phone: "", duty: "entry", post: "", date: fest.startDate >= today ? fest.startDate : today, startTime: "08:00", endTime: "13:00", eventIds: [], notes: "" },
  });
  const err = form.formState.errors;

  const gates = React.useMemo(() => [...new Set((events.data ?? []).flatMap((e) => e.gates))], [events.data]);

  const submit = form.handleSubmit(async (v) => {
    try {
      // Reuse an existing staff account with this email; otherwise issue one.
      let userId = (staff.data ?? []).find((s) => s.email === v.email.toLowerCase())?.id;
      let inviteResult: InviteResult | null = null;
      if (!userId) {
        const created = await create.mutateAsync({ name: v.name, email: v.email, phone: v.phone || undefined, role: "volunteer", festIds: [fest.id] });
        userId = created.user.id;
        inviteResult = created.invite;
      }
      await repos.shifts.create(
        { festId: fest.id, userId, post: v.post, duty: v.duty as ShiftDuty, date: v.date, startTime: v.startTime, endTime: v.endTime, eventIds: v.eventIds, notes: v.notes || undefined },
        session!.uid,
      );
      toast.success(`${v.name} rostered at ${v.post}`);
      if (inviteResult) onInvited({ email: v.email, result: inviteResult });
      form.reset({ ...form.getValues(), name: "", email: "", phone: "", notes: "", ...(again ? {} : { post: "", eventIds: [] }) });
    } catch (error) {
      toast.error(error instanceof ApiClientError || error instanceof RepositoryError ? error.message : "Couldn't create the volunteer");
    }
  });

  return (
    <form onSubmit={submit} noValidate className="card elev-sm gap-3.5 p-[17px]">
      <div>
        <div className="text-[18px] font-medium">Create volunteer</div>
        <div className="mt-[3px] text-[12px] text-neutral-500">Creates an volunteer account scoped to a post. Same route as Staff, pre-set to the volunteer duty.</div>
      </div>
      <Field label="Full name" htmlFor="v-name" error={err.name?.message}>
        <Input id="v-name" placeholder="Sanjana Reddy" {...form.register("name")} />
      </Field>
      <Field label="Email" htmlFor="v-email" error={err.email?.message}>
        <Input id="v-email" type="email" placeholder="name@college.edu" {...form.register("email")} />
      </Field>
      <Field label="Phone (for shift SMS)" htmlFor="v-phone" error={err.phone?.message}>
        <Input id="v-phone" type="tel" placeholder="+91" {...form.register("phone")} />
      </Field>
      <div>
        <Kick className="mb-[9px]">Duty</Kick>
        <RadioOption block label="Entry scanning" value="entry" {...form.register("duty")} />
        <RadioOption block label="Meal scanning" value="meal" {...form.register("duty")} />
        <RadioOption block label="Crowd & help desk — no scanning" value="crowd" {...form.register("duty")} />
      </div>
      <Field label="Post" htmlFor="v-post" error={err.post?.message}>
        <Input id="v-post" list="v-gates" placeholder="Gate A" {...form.register("post")} />
        <datalist id="v-gates">
          {gates.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Date" htmlFor="v-date" error={err.date?.message}>
          <Input id="v-date" type="date" {...form.register("date")} />
        </Field>
        <Field label="Shift start" htmlFor="v-start" error={err.startTime?.message}>
          <Input id="v-start" type="time" {...form.register("startTime")} />
        </Field>
        <Field label="Shift end" htmlFor="v-end" error={err.endTime?.message}>
          <Input id="v-end" type="time" {...form.register("endTime")} />
        </Field>
      </div>
      <div>
        <Kick className="mb-[9px]">Scoped to events</Kick>
        <div className="flex max-h-[140px] flex-col gap-1.5 overflow-y-auto">
          {(events.data ?? []).map((e) => (
            <CheckOption key={e.id} label={e.title} value={e.id} {...form.register("eventIds")} />
          ))}
        </div>
        <div className="field-hint">Leave all unticked for the whole fest.</div>
      </div>
      <Field label="Notes" htmlFor="v-notes" error={err.notes?.message} hint="Optional — visible to other admins.">
        <Textarea id="v-notes" rows={2} placeholder="Knows the north entrance layout; prefers morning shifts." {...form.register("notes")} />
      </Field>
      <div className="text-[12px] text-neutral-500">
        Role: volunteer, scoped to this fest. It cannot mark manual entry or edit registrations — those need at least admin. Your own session is untouched.
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" className="flex-1" onClick={() => setAgain(true)} loading={create.isPending && again}>
          Save & add another
        </Button>
        <Button type="submit" variant="primary" className="flex-1" onClick={() => setAgain(false)} loading={create.isPending && !again}>
          Create
        </Button>
      </div>
    </form>
  );
};

const EditShiftDialog = ({ shift, staff, onClose, onInvite }: { shift: Shift; staff?: StaffRow; onClose: () => void; onInvite: (i: { email: string; result: InviteResult }) => void }) => {
  const repos = useRepositories();
  const { fest } = useFest();
  const events = useFestEvents(fest.id);
  const resend = useResendInvite();
  const update = useUpdateStaff();
  const [post, setPost] = React.useState(shift.post);
  const [duty, setDuty] = React.useState<ShiftDuty>(shift.duty);
  const [start, setStart] = React.useState(shift.startTime);
  const [end, setEnd] = React.useState(shift.endTime);
  const [date, setDate] = React.useState(shift.date);
  const [eventIds, setEventIds] = React.useState(shift.eventIds);
  const [busy, setBusy] = React.useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await fn();
      toast.success(done ?? "Saved");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't do that");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={shift.userName} description={shift.userEmail} size="md">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Post" htmlFor="e-post">
            <Input id="e-post" value={post} onChange={(e) => setPost(e.target.value)} />
          </Field>
          <Field label="Duty" htmlFor="e-duty">
            <select id="e-duty" className="input" value={duty} onChange={(e) => setDuty(e.target.value as ShiftDuty)}>
              {(Object.keys(SHIFT_DUTY_LABELS) as ShiftDuty[]).map((d) => (
                <option key={d} value={d}>
                  {SHIFT_DUTY_LABELS[d]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date" htmlFor="e-date">
            <Input id="e-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start" htmlFor="e-start">
              <Input id="e-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="End" htmlFor="e-end">
              <Input id="e-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        </div>
        <div>
          <Kick className="mb-[9px]">Scoped to events</Kick>
          <div className="flex max-h-[140px] flex-col gap-1.5 overflow-y-auto">
            {(events.data ?? []).map((e) => (
              <CheckOption key={e.id} label={e.title} checked={eventIds.includes(e.id)} onChange={(ev) => setEventIds((ids) => (ev.target.checked ? [...ids, e.id] : ids.filter((x) => x !== e.id)))} />
            ))}
          </div>
        </div>
        <DialogActions className="flex-wrap justify-between">
          <div className="flex flex-wrap gap-2">
            {staff && !staff.activated ? (
              <Button
                variant="secondary"
                loading={busy === "resend" || resend.isPending}
                onClick={() =>
                  run("resend", async () => {
                    const result = await resend.mutateAsync(staff.id);
                    onInvite({ email: staff.email, result });
                  }, "Invite ready")
                }
              >
                Resend credentials
              </Button>
            ) : null}
            {staff ? (
              <Button variant="secondary" loading={busy === "revoke"} onClick={() => run("revoke", () => update.mutateAsync({ id: staff.id, disabled: !staff.disabled }), staff.disabled ? "Access restored" : "Access revoked")}>
                {staff.disabled ? "Restore access" : "Revoke access"}
              </Button>
            ) : null}
            <Button variant="danger" loading={busy === "delete"} onClick={() => run("delete", () => repos.shifts.delete(shift.id), "Shift removed")}>
              Remove shift
            </Button>
          </div>
          <Button variant="primary" loading={busy === "save"} onClick={() => run("save", () => repos.shifts.update(shift.id, { post, duty, date, startTime: start, endTime: end, eventIds }))}>
            Save
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
};
