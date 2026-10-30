"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useAuth } from "@/components/providers";
import { api } from "@/data/api-client";
import { phoneSchema } from "@/core/models/common";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { ImageUploadField } from "@/components/ui/image-upload";
import { Avatar } from "@/components/ui/overlays";
import { Tag } from "@/components/ui/primitives";

/**
 * A staff account's own profile — admin or volunteer alike.
 *
 * `updateUserSchema` (what the server accepts at `/api/auth/profile`) has no
 * `role` or `festIds` field at all, so there is nothing here, on either
 * account type, that could touch either. Those are set only by a super
 * admin, from Staff.
 */

const schema = z.object({
  name: z.string().trim().min(1, "Add your name").max(200),
  phone: z.union([phoneSchema, z.literal("")]).optional(),
  designation: z.string().trim().max(200).optional(),
  department: z.string().trim().max(200).optional(),
  avatar: z.union([z.string().url(), z.literal("")]).optional(),
});

type Values = z.input<typeof schema>;

const ROLE_LABEL: Record<string, string> = { super_admin: "Super admin", admin: "Admin", volunteer: "Volunteer" };

export const StaffProfileForm = () => {
  const { session, profile } = useAuth();
  const [saving, setSaving] = React.useState(false);

  const form = useForm<Values, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", phone: "", designation: "", department: "", avatar: "" },
    mode: "onBlur",
  });

  React.useEffect(() => {
    if (!profile) return;
    form.reset({
      name: profile.name ?? "",
      phone: profile.phone ?? "",
      designation: profile.designation ?? "",
      department: profile.department ?? "",
      avatar: profile.avatar ?? "",
    });
  }, [profile, form]);

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
          ...(values.department ? { department: values.department } : {}),
          ...(values.avatar ? { avatar: values.avatar } : {}),
        },
      });
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
      <form onSubmit={(e) => e.preventDefault()} noValidate className="grid grid-cols-1 gap-4">
        <div className="flex items-center gap-3">
          <Avatar name={profile?.name ?? session?.email ?? ""} src={profile?.avatar} size={52} />
          <div className="min-w-0">
            <div className="truncate text-[15px]">{profile?.name || "Unnamed"}</div>
            <div className="truncate text-[12px] text-neutral-500">
              {session?.email} · <Tag tone="accent">{ROLE_LABEL[session?.role ?? ""] ?? session?.role}</Tag>
            </div>
          </div>
        </div>

        <ImageUploadField
          id="p-avatar"
          label="Avatar"
          kind="profilePhoto"
          aspect="1/1"
          value={form.watch("avatar") ?? ""}
          onChange={(url) => form.setValue("avatar", url, { shouldDirty: true })}
          error={err.avatar?.message}
          hint="Square · PNG, JPEG or WebP up to 3 MB"
        />

        <Field label="Full name" htmlFor="p-name" error={err.name?.message}>
          <Input id="p-name" {...form.register("name")} />
        </Field>
        <Field label="Email" htmlFor="p-email" hint="Set by whoever created your account.">
          <Input id="p-email" value={session?.email ?? ""} readOnly disabled />
        </Field>
        <Field label="Phone" htmlFor="p-phone" error={err.phone?.message}>
          <Input id="p-phone" type="tel" placeholder="+91" {...form.register("phone")} />
        </Field>
        <Field label="Designation" htmlFor="p-desig" error={err.designation?.message} hint="e.g. Cultural secretary.">
          <Input id="p-desig" {...form.register("designation")} />
        </Field>
        <Field label="Department" htmlFor="p-dept" error={err.department?.message}>
          <Input id="p-dept" placeholder="Student Affairs" {...form.register("department")} />
        </Field>
      </form>

      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" onClick={save} loading={saving}>
          Save profile
        </Button>
        <Button asChild variant="secondary">
          <a href="/change-password">Change password</a>
        </Button>
      </div>

      <div className="mt-6 rounded-md p-3.5 text-[12.5px] text-neutral-500 shadow-[inset_0_0_0_1px_var(--color-divider)]">
        Your role and the fests you manage are set by a super admin from Staff — there is nothing on this page that changes either.
      </div>
    </>
  );
};
