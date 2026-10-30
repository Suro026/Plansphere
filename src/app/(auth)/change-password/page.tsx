"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { RepositoryError } from "@/core/models/common";
import { changePasswordSchema, type ChangePassword } from "@/core/models/user";
import { homeForRole } from "@/core/permissions";
import { api } from "@/data/api-client";
import { useAuth } from "@/components/providers";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Note, Skeleton } from "@/components/ui/primitives";
import { safeRedirect } from "@/lib/utils";

/**
 * Force a new password on an invited account.
 *
 * An account created by a super admin or an admin arrives with a temporary
 * password and `mustChangePassword` set. Until it is cleared the API refuses
 * every privileged call and the rules refuse every read, so this screen is
 * the only thing such a session can usefully do. It is also reachable
 * voluntarily by anyone who simply wants to change their password.
 */
export default function ChangePasswordPage() {
  const { status, session, refresh } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeRedirect(params.get("next"), "");
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<ChangePassword>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", password: "", confirmPassword: "" },
  });

  React.useEffect(() => {
    if (status === "signed-out") router.replace("/sign-in");
  }, [status, router]);

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api("/api/auth/change-password", { method: "POST", body: values });
      // The claim changed; pull a fresh token before routing on.
      await refresh();
      toast.success("Password changed");
      router.replace(next || (session ? homeForRole(session.role) : "/explore"));
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
  const forced = session.mustChangePassword;

  return (
    <>
      <AuthHeading
        kick={forced ? "One more step" : "Account"}
        title={forced ? "Choose your password" : "Change your password"}
        sub={
          forced
            ? "You signed in with the temporary password from your invitation. Pick your own to finish setting up the account."
            : "Enter the password you use now, then the one you would like instead."
        }
      />

      {forced ? (
        <Note className="mb-5" title="Until you do this, the account can't be used">
          The temporary password works only for this screen. Everything else — the scanner, registrations, the admin
          side — stays closed until you have chosen your own.
        </Note>
      ) : null}

      <form onSubmit={onSubmit} method="post" noValidate className="flex flex-col gap-4">
        <Field label={forced ? "Temporary password" : "Current password"} htmlFor="cp-current" error={err.currentPassword?.message}>
          <Input id="cp-current" type="password" autoComplete="current-password" invalid={Boolean(err.currentPassword)} {...form.register("currentPassword")} />
        </Field>

        <Field label="New password" htmlFor="cp-new" error={err.password?.message} hint="8+ characters, a capital and a number.">
          <Input id="cp-new" type="password" autoComplete="new-password" invalid={Boolean(err.password)} {...form.register("password")} />
        </Field>

        <Field label="Confirm new password" htmlFor="cp-confirm" error={err.confirmPassword?.message}>
          <Input id="cp-confirm" type="password" autoComplete="new-password" invalid={Boolean(err.confirmPassword)} {...form.register("confirmPassword")} />
        </Field>

        {formError ? (
          <p role="alert" className="text-[13px] text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" block loading={form.formState.isSubmitting}>
          Save password
        </Button>
      </form>
    </>
  );
}
