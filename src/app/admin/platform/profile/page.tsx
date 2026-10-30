"use client";

import * as React from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { useAuth } from "@/components/providers";
import { api } from "@/data/api-client";
import { phoneSchema, shortTextSchema } from "@/core/models/common";
import { AUDIT_ACTION_LABELS, type AuditAction } from "@/core/models/audit";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { ImageUploadField } from "@/components/ui/image-upload";
import { Avatar } from "@/components/ui/overlays";
import { Kick, MetaList, MetaRow, Note, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { formatRelative } from "@/lib/utils";

/**
 * The owner's own account.
 *
 * Identity on the left, the record of what this account has done on the
 * right. The activity log is the same audit trail every other screen reads,
 * filtered to this actor — the platform owner is the one person nobody else
 * reviews, so their actions being visible to them is the least that should
 * be true.
 */

const schema = z.object({
  name: shortTextSchema,
  phone: z.union([phoneSchema, z.literal("")]).optional(),
  designation: z.string().trim().max(200).optional(),
  organization: z.string().trim().max(200).optional(),
  bio: z.string().trim().max(600).optional(),
  avatar: z.union([z.string().url(), z.literal("")]).optional(),
});

type Values = z.input<typeof schema>;

interface ActivityEntry {
  id: string;
  action: AuditAction;
  summary: string;
  createdAt: string | null;
}

export default function PlatformProfilePage() {
  const { session, profile } = useAuth();
  const [saving, setSaving] = React.useState(false);

  const form = useForm<Values, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", phone: "", designation: "", organization: "", bio: "", avatar: "" },
    mode: "onBlur",
  });

  // The profile arrives after the first render; seed the form once it does.
  React.useEffect(() => {
    if (!profile) return;
    form.reset({
      name: profile.name ?? "",
      phone: profile.phone ?? "",
      designation: profile.designation ?? "",
      organization: profile.organization ?? "",
      bio: profile.bio ?? "",
      avatar: profile.avatar ?? "",
    });
  }, [profile, form]);

  const activity = useQuery({
    queryKey: ["my-activity", session?.uid],
    enabled: Boolean(session),
    queryFn: () => api<{ entries: ActivityEntry[] }>("/api/admin/platform/activity").then((r) => r.entries),
    staleTime: 20_000,
  });

  const save = async () => {
    const valid = await form.trigger();
    if (!valid) return;
    const values = schema.parse(form.getValues());

    setSaving(true);
    try {
      await api("/api/auth/profile", {
        method: "PATCH",
        body: {
          name: values.name,
          ...(values.phone ? { phone: values.phone } : {}),
          ...(values.designation ? { designation: values.designation } : {}),
          ...(values.organization ? { organization: values.organization } : {}),
          ...(values.bio ? { bio: values.bio } : {}),
          ...(values.avatar ? { avatar: values.avatar } : {}),
        },
      });
      // The profile document is subscribed live, so the form and the header
      // update themselves as soon as the write lands.
      toast.success("Profile saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the profile");
    } finally {
      setSaving(false);
    }
  };

  const err = form.formState.errors;

  return (
    <>
      <PageHeading kick="Account" title="Your profile" sub={session?.email ?? ""} className="mb-5" />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
        <div>
          <form onSubmit={(event) => event.preventDefault()} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex items-center gap-3 sm:col-span-2">
              <Avatar name={profile?.name ?? session?.email ?? ""} src={profile?.avatar} size={52} />
              <div className="min-w-0">
                <div className="truncate text-[15px]">{profile?.name || "Unnamed"}</div>
                <div className="truncate text-[12px] text-neutral-500">
                  {session?.email} · <Tag tone="accent">Super admin</Tag>
                </div>
              </div>
            </div>

            <ImageUploadField
              id="p-avatar"
              label="Avatar"
              kind="profilePhoto"
              aspect="1/1"
              className="sm:col-span-2"
              value={form.watch("avatar") ?? ""}
              onChange={(url) => form.setValue("avatar", url, { shouldDirty: true })}
              error={err.avatar?.message}
              hint="Square · PNG, JPEG or WebP up to 3 MB"
            />

            <Field label="Full name" htmlFor="p-name" error={err.name?.message}>
              <Input id="p-name" {...form.register("name")} />
            </Field>
            <Field label="Email" htmlFor="p-email" hint="Changing the sign-in address is not self-service.">
              <Input id="p-email" value={session?.email ?? ""} readOnly disabled />
            </Field>
            <Field label="Phone" htmlFor="p-phone" error={err.phone?.message}>
              <Input id="p-phone" type="tel" placeholder="+91" {...form.register("phone")} />
            </Field>
            <Field label="Organisation" htmlFor="p-org" error={err.organization?.message}>
              <Input id="p-org" placeholder="SRM Institute of Science & Technology" {...form.register("organization")} />
            </Field>
            <Field label="Designation" htmlFor="p-desig" error={err.designation?.message} className="sm:col-span-2">
              <Input id="p-desig" placeholder="Dean of Student Affairs" {...form.register("designation")} />
            </Field>
            <Field label="Bio" htmlFor="p-bio" error={err.bio?.message} className="sm:col-span-2" hint="Shown to admins you create.">
              <Textarea id="p-bio" rows={3} {...form.register("bio")} />
            </Field>
          </form>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="primary" onClick={save} loading={saving}>
              Save profile
            </Button>
            <Button asChild variant="secondary">
              <Link href="/change-password">Change password</Link>
            </Button>
          </div>

          <Note title="Two-factor authentication" className="mt-6 max-w-[62ch]">
            Not available yet. When it lands it will be required for this role rather than offered — a super admin account is the whole platform, and a password is thin protection for that. Until then: use a unique password from a manager, and keep the number of super admins at the minimum the college actually needs.
          </Note>
        </div>

        <aside>
          <Kick className="mb-2">Your activity</Kick>
          <p className="mb-3 text-[12.5px] text-neutral-500">
            Every privileged action this account has taken, newest first. Written by the server; nothing here can be edited or deleted from inside the app.
          </p>

          {activity.isPending ? (
            <Skeleton className="h-64" />
          ) : (activity.data ?? []).length === 0 ? (
            <p className="text-[13px] text-neutral-500">Nothing recorded yet.</p>
          ) : (
            <MetaList>
              {(activity.data ?? []).map((entry) => (
                <MetaRow key={entry.id} label={AUDIT_ACTION_LABELS[entry.action] ?? entry.action}>
                  <span className="block">{entry.summary}</span>
                  <span className="block text-[11.5px] text-neutral-500">
                    {formatRelative(entry.createdAt ? new Date(entry.createdAt) : null)}
                  </span>
                </MetaRow>
              ))}
            </MetaList>
          )}
        </aside>
      </div>
    </>
  );
}
