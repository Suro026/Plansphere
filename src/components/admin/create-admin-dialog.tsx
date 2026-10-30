"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { emailSchema, phoneSchema, shortTextSchema } from "@/core/models/common";
import { useCreateStaff } from "@/components/admin/staff-api";
import type { Credentials } from "@/components/admin/credentials-panel";
import { useManagedFests } from "@/components/shell/admin-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogContent, DialogTrigger } from "@/components/ui/overlays";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Note } from "@/components/ui/primitives";

/**
 * Create an admin.
 *
 * Name, email, phone, the fests they are responsible for — and that is the
 * whole form. There is deliberately no password box: the account is issued a
 * generated one, mailed it, and locked to replacing it on first sign-in, so
 * nobody ever chooses a password on someone else's behalf.
 */

const schema = z.object({
  name: shortTextSchema,
  email: emailSchema,
  phone: z.union([phoneSchema, z.literal("")]).optional(),
  designation: z.string().trim().max(200).optional(),
  role: z.enum(["admin", "super_admin"]),
  festIds: z.array(z.string()).default([]),
});

type Values = z.input<typeof schema>;

export const CreateAdminDialog = ({ onCreated }: { onCreated: (credentials: Credentials) => void }) => {
  const [open, setOpen] = React.useState(false);
  const fests = useManagedFests();
  const create = useCreateStaff();

  const form = useForm<Values, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", phone: "", designation: "", role: "admin", festIds: [] },
    mode: "onBlur",
  });

  const role = form.watch("role");
  const selected = form.watch("festIds") ?? [];

  const toggleFest = (id: string) => {
    const next = selected.includes(id) ? selected.filter((festId) => festId !== id) : [...selected, id];
    form.setValue("festIds", next, { shouldDirty: true, shouldValidate: true });
  };

  const submit = async () => {
    const valid = await form.trigger();
    if (!valid) return;
    const values = schema.parse(form.getValues());

    // A scoped admin with no fest can sign in and see nothing, which reads as
    // a broken account rather than a deliberate one.
    if (values.role === "admin" && values.festIds.length === 0) {
      form.setError("festIds", { message: "Assign at least one fest — an admin with none can see nothing." });
      return;
    }

    try {
      const result = await create.mutateAsync({
        name: values.name,
        email: values.email,
        role: values.role,
        festIds: values.festIds,
        ...(values.phone ? { phone: values.phone } : {}),
        ...(values.designation ? { designation: values.designation } : {}),
      });

      onCreated({
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        staffCode: result.user.staffCode ?? null,
        temporaryPassword: result.invite.temporaryPassword,
        ...(result.invite.setPasswordLink ? { setPasswordLink: result.invite.setPasswordLink } : {}),
        emailed: result.invite.emailed,
        provider: result.invite.provider,
      });

      toast.success(result.invite.emailed ? `Invitation sent to ${values.email}` : "Account created — the email could not be sent");
      form.reset();
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't create the account");
    }
  };

  const err = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary">Create an admin</Button>
      </DialogTrigger>
      <DialogContent title="Create an admin" description="They receive an email with a temporary password and set their own on first sign-in." size="md">
        <form onSubmit={(event) => event.preventDefault()} noValidate className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <Field label="Full name" htmlFor="a-name" error={err.name?.message}>
            <Input id="a-name" placeholder="Priya Ramesh" {...form.register("name")} />
          </Field>
          <Field label="Email" htmlFor="a-email" error={err.email?.message} hint="Where the credentials are sent.">
            <Input id="a-email" type="email" placeholder="priya@college.edu" {...form.register("email")} />
          </Field>
          <Field label="Phone" htmlFor="a-phone" error={err.phone?.message} hint="Optional.">
            <Input id="a-phone" type="tel" placeholder="+91" {...form.register("phone")} />
          </Field>
          <Field label="Designation" htmlFor="a-desig" error={err.designation?.message} hint="Optional — e.g. Cultural secretary.">
            <Input id="a-desig" {...form.register("designation")} />
          </Field>
          <Field label="Role" htmlFor="a-role" error={err.role?.message} className="sm:col-span-2">
            <NativeSelect id="a-role" {...form.register("role")}>
              <option value="admin">Admin — runs the fests you assign</option>
              <option value="super_admin">Super admin — the whole platform</option>
            </NativeSelect>
          </Field>

          {role === "admin" ? (
            <Field label="Assigned fests" error={err.festIds?.message} className="sm:col-span-2" hint="They see only these.">
              <div className="flex flex-wrap gap-1.5">
                {(fests.data ?? []).length === 0 ? (
                  <span className="text-[13px] text-neutral-500">No fests exist yet — create one first.</span>
                ) : (
                  (fests.data ?? []).map((fest) => (
                    <button
                      key={fest.id}
                      type="button"
                      aria-pressed={selected.includes(fest.id)}
                      className={selected.includes(fest.id) ? "tag tag-accent cursor-pointer" : "tag tag-outline cursor-pointer"}
                      onClick={() => toggleFest(fest.id)}
                    >
                      {fest.name}
                    </button>
                  ))
                )}
              </div>
            </Field>
          ) : (
            <Note title="Super admins are unscoped" className="sm:col-span-2">
              They reach every fest on the platform, can create other admins, and are the only role that can release certificates. Create them sparingly.
            </Note>
          )}
        </form>

        <DialogActions>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>
            Create and email
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
};
