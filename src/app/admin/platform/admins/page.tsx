"use client";

import * as React from "react";
import { toast } from "sonner";
import { useStaff, useUpdateStaff, type StaffRow } from "@/components/admin/staff-api";
import { useResetStaffPassword } from "@/components/admin/platform-api";
import { CreateAdminDialog } from "@/components/admin/create-admin-dialog";
import { CredentialsPanel, type Credentials } from "@/components/admin/credentials-panel";
import { useManagedFests } from "@/components/shell/admin-shell";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/overlays";
import { EmptyState, Note, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { formatRelative } from "@/lib/utils";

/**
 * Admin accounts.
 *
 * The one place an admin comes into existence. There is no sign-up for this
 * role anywhere in the product — an account is created here, mailed a
 * temporary password, and forced to replace it before it can do anything.
 */
export default function PlatformAdminsPage() {
  const staff = useStaff();
  const fests = useManagedFests();
  const update = useUpdateStaff();
  const reset = useResetStaffPassword();
  const [issued, setIssued] = React.useState<Credentials | null>(null);

  const festName = React.useCallback(
    (id: string) => fests.data?.find((fest) => fest.id === id)?.name ?? id,
    [fests.data],
  );

  const admins = (staff.data ?? []).filter((row) => row.role === "admin" || row.role === "super_admin");

  const regenerate = async (row: StaffRow) => {
    try {
      const result = await reset.mutateAsync(row.id);
      setIssued({ ...result, name: row.name, staffCode: row.staffCode ?? null });
      toast.success(result.emailed ? `New password mailed to ${row.email}` : "New password issued — the email could not be sent, so pass it on yourself");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't issue a new password");
    }
  };

  const setDisabled = async (row: StaffRow, disabled: boolean) => {
    try {
      await update.mutateAsync({ id: row.id, disabled });
      toast.success(disabled ? `${row.name} can no longer sign in` : `${row.name} is active again`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update the account");
    }
  };

  return (
    <>
      <PageHeading
        kick="Accounts"
        title="Admins"
        sub={`${admins.length} account${admins.length === 1 ? "" : "s"} · created here, never self-registered`}
        actions={<CreateAdminDialog onCreated={setIssued} />}
        className="mb-5"
      />

      {issued ? (
        <CredentialsPanel credentials={issued} onDismiss={() => setIssued(null)} className="mb-6" />
      ) : null}

      {staff.isPending ? (
        <Skeleton className="h-56" />
      ) : admins.length === 0 ? (
        <EmptyState
          title="No admins yet"
          body="An admin runs one or more fests: their events, registrations, gate and results. Create one, assign the fests they are responsible for, and they will be emailed a temporary password."
          action={<CreateAdminDialog onCreated={setIssued} />}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Admin</th>
                <th>Admin ID</th>
                <th>Role</th>
                <th>Assigned fests</th>
                <th>Last sign-in</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {admins.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.name || "—"}
                    <div className="truncate text-[11.5px] text-neutral-500">{row.email}</div>
                  </td>
                  <td className="whitespace-nowrap font-mono text-[12px] text-neutral-400">{row.staffCode ?? "—"}</td>
                  <td className="whitespace-nowrap">{row.role === "super_admin" ? "Super admin" : "Admin"}</td>
                  <td>
                    {row.role === "super_admin" ? (
                      <span className="text-neutral-400">Every fest</span>
                    ) : row.festIds.length === 0 ? (
                      <span className="text-neutral-500">None</span>
                    ) : (
                      row.festIds.map(festName).join(", ")
                    )}
                  </td>
                  <td className="whitespace-nowrap text-neutral-400">
                    {row.lastSignInAt ? formatRelative(new Date(row.lastSignInAt)) : "Never"}
                  </td>
                  <td className="whitespace-nowrap">
                    {row.disabled ? (
                      <Tag tone="neutral">Disabled</Tag>
                    ) : row.mustChangePassword ? (
                      <Tag tone="outline">Temporary password</Tag>
                    ) : (
                      <Tag tone="accent">Active</Tag>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button type="button" className="btn btn-ghost text-[12px]">
                          New password
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent
                        title={`Issue a new temporary password for ${row.name || row.email}?`}
                        description="Their current password stops working immediately and every open session is signed out. The new one is mailed to them and shown here once."
                        confirmLabel="Issue it"
                        onConfirm={() => regenerate(row)}
                      />
                    </AlertDialog>
                    <button
                      type="button"
                      className="btn btn-ghost text-[12px]"
                      onClick={() => setDisabled(row, !row.disabled)}
                      disabled={update.isPending}
                    >
                      {row.disabled ? "Re-enable" : "Disable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Note title="Where the password lives" className="mt-6 max-w-[62ch]">
        Nowhere. Firebase stores a one-way hash, and Plansphere never writes a password to Firestore — the value above exists for as long as this page is open and then it is gone. If it is lost, issue another one; there is no way to read the old one back.
      </Note>
    </>
  );
}
