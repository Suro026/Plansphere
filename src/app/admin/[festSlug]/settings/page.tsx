"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useAuth, useRepositories } from "@/components/providers";
import { FestFields, festFormSchema, fromFest, toUpdateFest, useFestForm } from "@/components/admin/fest-form";
import { useFestAction } from "@/components/admin/platform-api";
import { PaymentAccountPanel } from "@/components/admin/payment-account-panel";
import { RegistrationFieldsEditor } from "@/components/admin/registration-fields-editor";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent } from "@/components/ui/overlays";
import { EmptyState, MetaList, MetaRow, PageHeading, Tag } from "@/components/ui/primitives";
import { RepositoryError } from "@/core/models/common";
import { hasAtLeast } from "@/core/models/user";
import { formatCount } from "@/lib/utils";

/**
 * Fest settings — the fest's own details, publish state and danger zone.
 * Not drawn in the canvas (the wizard covers events; this covers the fest
 * that holds them). Admin and above.
 */
export default function FestSettingsPage() {
  const { fest } = useFest();
  const { session } = useAuth();
  const repos = useRepositories();
  const client = useQueryClient();
  const form = useFestForm(fromFest(fest));
  const [saving, setSaving] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<"unpublish" | "archive" | null>(null);
  const action = useFestAction();

  const isAdmin = session ? hasAtLeast(session.role, "admin") : false;
  const isSuper = session ? hasAtLeast(session.role, "super_admin") : false;

  React.useEffect(() => {
    if (!form.formState.isDirty) form.reset(fromFest(fest));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fest.updatedAt.getTime()]);

  if (!isAdmin) {
    return (
      <AdminPage className="pt-[26px]">
        <EmptyState title="Admins edit the fest" body="Organizers can see the details but not change them." />
      </AdminPage>
    );
  }

  const refresh = () => client.invalidateQueries({ queryKey: ["managed-fests"] });

  const save = async () => {
    const valid = await form.trigger();
    if (!valid) return toast.error("Some fields need fixing");
    setSaving(true);
    try {
      await repos.fests.update(fest.id, toUpdateFest(festFormSchema.parse(form.getValues())));
      toast.success("Saved");
      form.reset(form.getValues());
      refresh();
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (status: "draft" | "published" | "archived", label: string) => {
    setBusy(status);
    try {
      // Archiving and un-archiving are the platform owner's and travel
      // through the server so they land in the audit trail; publishing and
      // unpublishing are the running admin's and stay a direct write.
      if (status === "archived") {
        await action.mutateAsync({ id: fest.id, action: "archive" });
      } else if (fest.status === "archived") {
        await action.mutateAsync({ id: fest.id, action: "reopen", status });
      } else {
        await repos.fests.setStatus(fest.id, status);
      }
      toast.success(label);
      setConfirm(null);
      refresh();
    } catch (error) {
      toast.error(error instanceof RepositoryError || error instanceof Error ? error.message : "Couldn't update");
    } finally {
      setBusy(null);
    }
  };

  const dirty = form.formState.isDirty;

  return (
    <AdminPage className="max-w-[820px] pb-8 pt-[26px]">
      <PageHeading
        title="Fest settings"
        sub={`${fest.name} · ${fest.status} · ${formatCount(fest.stats.events)} events · ${formatCount(fest.stats.registrations)} registrations`}
        actions={
          <>
            <Tag tone={fest.status === "published" ? "accent" : "neutral"}>{fest.status[0]!.toUpperCase() + fest.status.slice(1)}</Tag>
            {dirty ? (
              <Button variant="primary" onClick={save} loading={saving}>
                Save changes
              </Button>
            ) : null}
          </>
        }
        className="mb-5"
      />

      <form onSubmit={(e) => e.preventDefault()} noValidate>
        <FestFields form={form} lockSlug={fest.status !== "draft"} festId={fest.id} />
      </form>

      {dirty ? (
        <div className="mt-5 flex gap-2">
          <Button variant="primary" onClick={save} loading={saving}>
            Save changes
          </Button>
          <Button variant="secondary" onClick={() => form.reset(fromFest(fest))}>
            Discard
          </Button>
        </div>
      ) : null}

      {isSuper ? (
        <section className="mt-10 border-t border-divider pt-7" aria-labelledby="fest-registration-fields">
          <h2 id="fest-registration-fields" className="mb-1 text-[19px]">
            What this fest asks for
          </h2>
          <p className="mb-5 max-w-[68ch] text-[13.5px] text-neutral-400">
            The details every student provides when they register for any event in {fest.name}. An individual event can add its own questions on top of these from its own settings — this is the baseline every event starts from.
          </p>
          <RegistrationFieldsEditor
            initial={fest.registrationFields}
            onSave={(fields) => action.mutateAsync({ id: fest.id, action: "registrationFields", fields }).then(() => undefined)}
          />
        </section>
      ) : null}

      <section className="mt-10 border-t border-divider pt-7" aria-labelledby="fest-payments">
        <h2 id="fest-payments" className="mb-1 text-[19px]">
          Online payment
        </h2>
        <p className="mb-5 max-w-[68ch] text-[13.5px] text-neutral-400">
          Optional. Free events never need this. To collect an entry fee through Plansphere, connect {fest.name}’s own merchant account here, then switch on “Collect the entry fee online” for the event.
        </p>
        <PaymentAccountPanel festId={fest.id} />
      </section>

      <div className="mt-8">
        <MetaList>
          <MetaRow label="Public page" mono>
            /f/{fest.slug}
          </MetaRow>
          <MetaRow label="Visibility">{fest.status === "published" ? "Listed on Explore and reachable by link" : fest.status === "draft" ? "Hidden — staff only" : "Archived — hidden, records kept"}</MetaRow>
          <MetaRow label="Registrations">{fest.status === "published" ? "Open on published events" : "Closed while unpublished"}</MetaRow>
        </MetaList>
      </div>

      <div className="mt-6 rounded-md p-[17px] shadow-[inset_0_0_0_1px_var(--color-neutral-700)]">
        <div className="mb-1.5 text-[14px]">Publishing</div>
        <div className="mb-3.5 text-[12.5px] text-neutral-400">
          Publishing lists the fest and lets students register for its published events. Unpublishing hides it but keeps every registration and scan.
        </div>
        <div className="flex flex-wrap gap-2">
          {fest.status !== "published" ? (
            <Button variant="primary" onClick={() => setStatus("published", "Fest is live")} loading={busy === "published"}>
              Publish fest
            </Button>
          ) : (
            <AlertDialog open={confirm === "unpublish"} onOpenChange={(o) => setConfirm(o ? "unpublish" : null)}>
              <Button variant="secondary" onClick={() => setConfirm("unpublish")}>
                Unpublish
              </Button>
              <AlertDialogContent
                title="Unpublish this fest?"
                description="It disappears from Explore and its public page returns 404 until republished. Nothing is deleted."
                confirmLabel="Unpublish"
                loading={busy === "draft"}
                onConfirm={() => setStatus("draft", "Fest unpublished")}
              />
            </AlertDialog>
          )}
          {isSuper && fest.status !== "archived" ? (
            <AlertDialog open={confirm === "archive"} onOpenChange={(o) => setConfirm(o ? "archive" : null)}>
              <Button variant="danger" onClick={() => setConfirm("archive")}>
                Archive
              </Button>
              <AlertDialogContent
                title="Archive this fest?"
                description="Hidden everywhere, read-only, records kept for the college. Use this once the fest is over and certificates are out."
                confirmLabel="Archive fest"
                destructive
                loading={busy === "archived"}
                onConfirm={() => setStatus("archived", "Fest archived")}
              />
            </AlertDialog>
          ) : null}
          {isSuper ? (
            <Button asChild variant="ghost">
              <Link href="/admin/fests">All fests</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </AdminPage>
  );
}
