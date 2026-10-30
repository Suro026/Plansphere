"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Copy } from "@phosphor-icons/react";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useAuth } from "@/components/providers";
import { useCreateStaff, useDeleteStaff, useResendInvite, useStaff, useUpdateStaff, type InviteResult, type StaffRow } from "@/components/admin/staff-api";
import { Seg, Field, Input, RadioOption, CheckOption } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { EmptyState, Kick, MetaList, MetaRow, Note, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { emailSchema, shortTextSchema } from "@/core/models/common";
import { creatableRoles, hasAtLeast, type UserRole } from "@/core/permissions";
import { ApiClientError } from "@/data/api-client";
import { formatRelative } from "@/lib/utils";

const ROLE_LABEL: Record<UserRole, string> = { student: "Student", volunteer: "Volunteer", admin: "Admin", super_admin: "Super admin" };

const createSchema = z.object({
  name: shortTextSchema,
  email: emailSchema,
  designation: z.string().trim().max(200).optional(),
  role: z.enum(["volunteer", "admin", "super_admin"]),
  festIds: z.array(z.string()),
});
type CreateValues = z.input<typeof createSchema>;

type Filter = "all" | "admins" | "volunteers" | "pending";

/**
 * 3c — Staff & roles. The list, the create panel, and the manage dialog.
 * Only a super admin can grant a role above student; admins see the list.
 */
export default function StaffPage() {
  const { fest, fests } = useFest();
  const { session } = useAuth();
  const staff = useStaff();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const [manage, setManage] = React.useState<StaffRow | null>(null);
  const [invite, setInvite] = React.useState<{ email: string; result: InviteResult } | null>(null);

  const isSuper = session ? hasAtLeast(session.role, "super_admin") : false;
  const isOwner = session ? session.uid === fest.ownerId : false;
  // Admins create volunteers for the fests they manage; an admin who
  // registered this fest may also create other admins for it; super admins
  // create anything. The matrix decides, not a role comparison written here.
  const canCreate = session ? creatableRoles(session.role, isOwner) : [];
  const festName = React.useCallback((ids: string[]) => (ids.length === 0 ? "All fests" : ids.map((id) => fests.find((f) => f.id === id)?.name ?? "…").join(", ")), [fests]);

  const rows = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return (staff.data ?? [])
      .filter((s) => (filter === "admins" ? s.role !== "volunteer" : filter === "volunteers" ? s.role === "volunteer" : filter === "pending" ? !s.activated : true))
      .filter((s) => !term || s.name.toLowerCase().includes(term) || s.email.toLowerCase().includes(term))
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : rank(b.role) - rank(a.role)));
  }, [staff.data, filter, search]);

  return (
    <AdminPage className="grid grid-cols-1 gap-10 pb-9 pt-[26px] lg:grid-cols-[1fr_356px]">
      <div className="min-w-0">
        <PageHeading
          title="Staff"
          sub={`${staff.data?.length ?? "—"} accounts above student · roles are server-issued from the auth token, never browser state`}
          className="mb-4"
        />
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
          <Seg
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "admins", label: "Admins" },
              { value: "volunteers", label: "Volunteers" },
              { value: "pending", label: "Pending" },
            ]}
            aria-label="Filter staff"
          />
          <Input type="search" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-[200px]" aria-label="Search staff" />
        </div>

        {staff.isPending ? (
          <Skeleton className="h-56" />
        ) : rows.length === 0 ? (
          <EmptyState title="Nobody here yet" body="Create the first admin from the panel on the right." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Scoped to</th>
                  <th>Last active</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.activated ? s.name : s.email}
                      {s.activated ? <div className="text-[11.5px] text-neutral-500">{s.email}</div> : null}
                    </td>
                    <td>{ROLE_LABEL[s.role]}</td>
                    <td className="max-w-[220px] truncate">{s.role === "super_admin" ? "All fests" : festName(s.festIds)}</td>
                    <td className="whitespace-nowrap">{s.lastSignInAt ? formatRelative(new Date(s.lastSignInAt)) : "—"}</td>
                    <td>
                      {s.disabled ? <Tag tone="neutral">Disabled</Tag> : s.activated ? <Tag tone="accent">Active</Tag> : (
                        <Tag tone="neutral">Not activated{s.createdAt ? ` · ${formatRelative(new Date(s.createdAt)).replace(" ago", "")}` : ""}</Tag>
                      )}
                    </td>
                    <td className="text-right">
                      {isSuper ? (
                        <button type="button" className="btn btn-ghost text-[12px]" onClick={() => setManage(s)}>
                          {s.activated ? (s.id === session?.uid ? "You" : "Edit") : "Resend link"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3.5">
        {canCreate.length ? (
          <CreateStaffCard defaultFestId={fest.id} allowed={canCreate} onInvited={setInvite} />
        ) : (
          <Note title="You cannot grant roles">
            You can see who has access. Ask an admin or a super admin to add or change accounts.
          </Note>
        )}
        <Note title="Four roles, one scope rule">
          Student, volunteer, admin, super admin. A volunteer scans entry and meals and nothing else; an admin runs the
          fests assigned to them; only a super admin is unscoped and only a super admin creates admins.
          Every request is checked against role and fest on the server; no query crosses fests.
          <div className="mt-2.5 text-text">Staff here, volunteers next door</div>
          This page owns the accounts that configure a fest. Day-of scanning staff are volunteer accounts too, but they are rostered by post and shift on Volunteers — one account, managed where the work is.
        </Note>
      </div>

      {manage ? <ManageDialog row={manage} onClose={() => setManage(null)} onInvite={setInvite} /> : null}

      <Dialog open={invite !== null} onOpenChange={(o) => !o && setInvite(null)}>
        {invite ? (
          <DialogContent title={invite.result.emailed ? "Invitation sent" : "Pass this link on"} description={invite.email}>
            {invite.result.emailed ? (
              <div className="text-[13.5px] text-neutral-300">A one-time link to set their password is on its way. It expires in an hour.</div>
            ) : (
              <>
                <div className="text-[13.5px] text-neutral-300">
                  No email provider is configured yet, so the link wasn’t sent. Copy it and send it yourself — it is single-use and expires.
                </div>
                <div className="code break-all rounded-md bg-bg p-3 text-[11.5px] tracking-normal">{invite.result.setPasswordLink}</div>
                <DialogActions>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      await navigator.clipboard.writeText(invite.result.setPasswordLink ?? "");
                      toast.success("Link copied");
                    }}
                  >
                    <Copy size={14} /> Copy link
                  </Button>
                </DialogActions>
              </>
            )}
          </DialogContent>
        ) : null}
      </Dialog>
    </AdminPage>
  );
}

const rank = (r: UserRole) => ({ student: 0, volunteer: 1, admin: 2, super_admin: 3 })[r];

const CreateStaffCard = ({ defaultFestId, allowed, onInvited }: { defaultFestId: string; allowed: UserRole[]; onInvited: (i: { email: string; result: InviteResult }) => void }) => {
  const { fests } = useFest();
  const create = useCreateStaff();
  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", email: "", designation: "", role: "volunteer", festIds: [defaultFestId] },
  });
  const role = form.watch("role");
  const err = form.formState.errors;

  const submit = form.handleSubmit(async (v) => {
    try {
      const result = await create.mutateAsync({
        name: v.name,
        email: v.email,
        designation: v.designation || undefined,
        role: v.role,
        festIds: v.role === "super_admin" ? [] : v.festIds,
      });
      toast.success(`${v.name} added as ${ROLE_LABEL[v.role].toLowerCase()}`);
      onInvited({ email: v.email, result: result.invite });
      form.reset({ name: "", email: "", designation: "", role: "volunteer", festIds: [defaultFestId] });
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : "Couldn't create the account");
    }
  });

  return (
    <form onSubmit={submit} noValidate className="card elev-sm gap-3.5 p-[17px]">
      <div>
        <div className="text-[18px] font-medium">Create staff account</div>
        <div className="mt-[3px] text-[12px] text-neutral-500">
          {allowed.includes("super_admin")
            ? "Only a super admin can grant a role above student."
            : allowed.includes("admin")
              ? "You registered this event, so you can also add other admins to run it with you."
              : "You can invite volunteers for the fests you manage."}
        </div>
      </div>
      <Field label="Full name" htmlFor="st-name" error={err.name?.message}>
        <Input id="st-name" placeholder="Meena R. Kumar" {...form.register("name")} />
      </Field>
      <Field label="Email" htmlFor="st-email" error={err.email?.message}>
        <Input id="st-email" type="email" placeholder="name@college.edu" {...form.register("email")} />
      </Field>
      <Field label="Designation (optional)" htmlFor="st-desig">
        <Input id="st-desig" placeholder="Assistant Professor, CSE" {...form.register("designation")} />
      </Field>
      <div>
        <Kick className="mb-[9px]">Role</Kick>
        {allowed.includes("volunteer") ? (
          <RadioOption block label="Volunteer — scans entry and meals" value="volunteer" {...form.register("role")} />
        ) : null}
        {allowed.includes("admin") ? (
          <RadioOption block label="Admin — runs the assigned fests end to end" value="admin" {...form.register("role")} />
        ) : null}
        {allowed.includes("super_admin") ? (
          <RadioOption block label="Super admin — every fest, creates admins" value="super_admin" {...form.register("role")} />
        ) : null}
      </div>
      {role !== "super_admin" ? (
        <div>
          <Kick className="mb-[9px]">Scope to fests</Kick>
          <div className="flex flex-col gap-1.5">
            {fests.map((f) => (
              <CheckOption key={f.id} label={f.name} value={f.id} {...form.register("festIds")} />
            ))}
          </div>
          {err.festIds ? <div className="field-error">{String(err.festIds.message)}</div> : null}
        </div>
      ) : null}
      <div className="text-[12px] text-neutral-500">
        The account is created on the server and sent a one-time link; they set their own password on first sign-in. Your session is untouched.
      </div>
      <Button type="submit" variant="primary" block loading={create.isPending}>
        Create account
      </Button>
    </form>
  );
};

const ManageDialog = ({ row, onClose, onInvite }: { row: StaffRow; onClose: () => void; onInvite: (i: { email: string; result: InviteResult }) => void }) => {
  const { fests } = useFest();
  const { session } = useAuth();
  const update = useUpdateStaff();
  const remove = useDeleteStaff();
  const resend = useResendInvite();
  const [role, setRole] = React.useState<"volunteer" | "admin" | "super_admin">(row.role === "student" ? "volunteer" : row.role);
  const [festIds, setFestIds] = React.useState<string[]>(row.festIds);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const self = row.id === session?.uid;

  const save = async () => {
    try {
      await update.mutateAsync({ id: row.id, role, festIds: role === "super_admin" ? [] : festIds });
      toast.success("Saved — they'll need to sign in again for the new role to apply");
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : "Couldn't save");
    }
  };

  const toggleDisabled = async () => {
    try {
      await update.mutateAsync({ id: row.id, disabled: !row.disabled });
      toast.success(row.disabled ? "Account re-enabled" : "Account disabled — signed out everywhere");
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : "Couldn't update");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={row.name || row.email} description={row.email} size="md">
        <MetaList>
          <MetaRow label="Status">{row.disabled ? "Disabled" : row.activated ? "Active" : "Invite not used yet"}</MetaRow>
          <MetaRow label="Last active">{row.lastSignInAt ? formatRelative(new Date(row.lastSignInAt)) : "Never"}</MetaRow>
        </MetaList>

        {!row.activated ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={resend.isPending}
              onClick={async () => {
                try {
                  const result = await resend.mutateAsync(row.id);
                  onInvite({ email: row.email, result });
                  onClose();
                } catch (error) {
                  toast.error(error instanceof ApiClientError ? error.message : "Couldn't resend");
                }
              }}
            >
              Resend invitation link
            </Button>
          </div>
        ) : null}

        <div>
          <Kick className="mb-[9px]">Role</Kick>
          <RadioOption block name="m-role" label="Admin" checked={role === "admin"} onChange={() => setRole("admin")} disabled={self} />
          <RadioOption block name="m-role" label="Volunteer" checked={role === "volunteer"} onChange={() => setRole("volunteer")} disabled={self} />
          <RadioOption block name="m-role" label="Super admin" checked={role === "super_admin"} onChange={() => setRole("super_admin")} disabled={self} />
          {self ? <div className="field-hint">You can't change your own role — ask another super admin.</div> : null}
        </div>
        {role !== "super_admin" ? (
          <div>
            <Kick className="mb-[9px]">Scoped to</Kick>
            <div className="flex flex-col gap-1.5">
              {fests.map((f) => (
                <CheckOption
                  key={f.id}
                  label={f.name}
                  checked={festIds.includes(f.id)}
                  onChange={(e) => setFestIds((ids) => (e.target.checked ? [...ids, f.id] : ids.filter((x) => x !== f.id)))}
                />
              ))}
            </div>
          </div>
        ) : null}

        <DialogActions className="flex-wrap justify-between">
          <div className="flex gap-2">
            {!self ? (
              <Button variant="secondary" onClick={toggleDisabled} loading={update.isPending}>
                {row.disabled ? "Re-enable" : "Disable"}
              </Button>
            ) : null}
            {!self ? (
              <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
                <AlertDialogContent
                  title={`Delete ${row.name || row.email}?`}
                  description="Removes the sign-in and the profile. Their scan history and audit entries are kept."
                  confirmLabel="Delete account"
                  destructive
                  loading={remove.isPending}
                  onConfirm={async () => {
                    try {
                      await remove.mutateAsync(row.id);
                      toast.success("Account deleted");
                      onClose();
                    } catch (error) {
                      toast.error(error instanceof ApiClientError ? error.message : "Couldn't delete");
                      setConfirmDelete(false);
                    }
                  }}
                />
              </AlertDialog>
            ) : null}
          </div>
          {!self ? (
            <Button variant="primary" onClick={save} loading={update.isPending}>
              Save
            </Button>
          ) : null}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
};
