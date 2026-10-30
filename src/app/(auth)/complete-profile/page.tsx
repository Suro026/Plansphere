"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { RepositoryError } from "@/core/models/common";
import { studentProfileSchema, type StudentProfileInput } from "@/core/models/user";
import { api } from "@/data/api-client";
import { useAuth } from "@/components/providers";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/primitives";
import { safeRedirect } from "@/lib/utils";

/**
 * Profile completion, straight after sign-up.
 *
 * A pass carries a name and a college, and a certificate carries the name
 * exactly as it is typed here — so a student who skipped a field at sign-up
 * (or was created by an import) fills it in once, here, before registering
 * for anything. Staff never see this screen: their invitation is their
 * profile.
 */
export default function CompleteProfilePage() {
  const { status, session, profile, refresh } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeRedirect(params.get("next"), "");
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<StudentProfileInput>({
    resolver: zodResolver(studentProfileSchema),
    defaultValues: { name: "", phone: "", college: "", studentId: "", department: "" },
  });

  const { reset } = form;
  React.useEffect(() => {
    if (status === "signed-out") router.replace("/sign-in");
  }, [status, router]);

  // Prefill from whatever the account already has.
  React.useEffect(() => {
    if (!profile) return;
    reset({
      name: profile.name ?? "",
      phone: profile.phone ?? "",
      college: profile.college ?? "",
      studentId: profile.studentId ?? "",
      department: profile.department ?? "",
      year: profile.year,
    });
  }, [profile, reset]);

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api("/api/auth/profile", { method: "POST", body: values });
      await refresh();
      toast.success("Profile saved");
      router.replace(next || "/explore");
    } catch (error) {
      setFormError(error instanceof RepositoryError ? error.message : "Something went wrong. Please try again.");
    }
  });

  if (status === "loading" || !session) {
    return (
      <div aria-busy>
        <Skeleton className="mb-3 h-3 w-24" />
        <Skeleton className="mb-8 h-9 w-64" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  const err = form.formState.errors;

  return (
    <>
      <AuthHeading
        kick="Almost there"
        title="Complete your profile"
        sub="Your pass and your certificates carry these details, so they are worth getting right. You can change them later from Profile."
      />

      <form onSubmit={onSubmit} method="post" noValidate className="flex flex-col gap-4">
        <Field label="Full name" htmlFor="cp-name" error={err.name?.message} hint="As it should appear on certificates.">
          <Input id="cp-name" autoComplete="name" invalid={Boolean(err.name)} {...form.register("name")} />
        </Field>

        <Field label="Phone" htmlFor="cp-phone" error={err.phone?.message}>
          <Input id="cp-phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+91" invalid={Boolean(err.phone)} {...form.register("phone")} />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="College" htmlFor="cp-college" error={err.college?.message}>
            <Input id="cp-college" autoComplete="organization" invalid={Boolean(err.college)} {...form.register("college")} />
          </Field>
          <Field label="College ID (optional)" htmlFor="cp-studentId" error={err.studentId?.message}>
            <Input id="cp-studentId" placeholder="RA2211003010" {...form.register("studentId")} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Department (optional)" htmlFor="cp-department" error={err.department?.message}>
            <Input id="cp-department" placeholder="CSE" {...form.register("department")} />
          </Field>
          <Field label="Year (optional)" htmlFor="cp-year" error={err.year?.message}>
            <NativeSelect id="cp-year" {...form.register("year", { setValueAs: (v) => (v === "" ? undefined : Number(v)) })}>
              <option value="">—</option>
              {[1, 2, 3, 4, 5, 6].map((y) => (
                <option key={y} value={y}>
                  Year {y}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>

        {formError ? (
          <p role="alert" className="text-[13px] text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" block loading={form.formState.isSubmitting}>
          Save and continue
        </Button>
      </form>
    </>
  );
}
