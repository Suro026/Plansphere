"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { passwordSchema, passwordsMatch } from "@/core/models/user";
import { AuthError } from "@/core/services/auth-service";
import { useAuth } from "@/components/providers";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { EmptyState, MetaList, MetaRow, Skeleton } from "@/components/ui/primitives";
import { homeFor } from "@/components/shell/require-role";

/**
 * Sets a password from an emailed link.
 *
 * The same page serves two arrivals: a staff invite (the account was created
 * by a super admin and has no usable password yet) and a self-service reset.
 * Firebase issues the same kind of code for both, so the only difference is
 * the wording.
 */
const schema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, passwordsMatch);

type Phase = { kind: "checking" } | { kind: "ready"; email: string } | { kind: "invalid"; message: string } | { kind: "done" };

export default function SetPasswordPage() {
  const { auth } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const code = params.get("oobCode") ?? "";
  const isInvite = params.get("invite") === "1";

  const [phase, setPhase] = React.useState<Phase>({ kind: "checking" });
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<z.input<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  React.useEffect(() => {
    if (!code) {
      setPhase({ kind: "invalid", message: "This link is missing its code. Open the link from the email again." });
      return;
    }
    auth
      .verifyPasswordResetCode(code)
      .then((email) => setPhase({ kind: "ready", email }))
      .catch((error) =>
        setPhase({ kind: "invalid", message: error instanceof AuthError ? error.message : "This link is not valid." }),
      );
  }, [code, auth]);

  const onSubmit = form.handleSubmit(async ({ password }) => {
    if (phase.kind !== "ready") return;
    setFormError(null);
    try {
      await auth.confirmPasswordReset(code, password);
      // Sign them straight in — asking someone to retype what they just set
      // is friction with no security benefit.
      const session = await auth.signIn(phase.email, password);
      setPhase({ kind: "done" });
      router.replace(homeFor(session.role));
    } catch (error) {
      setFormError(error instanceof AuthError ? error.message : "Something went wrong. Please try again.");
    }
  });

  if (phase.kind === "checking") {
    return (
      <div aria-busy>
        <Skeleton className="mb-3 h-3 w-24" />
        <Skeleton className="mb-8 h-9 w-64" />
        <Skeleton className="mb-4 h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  if (phase.kind === "invalid") {
    return (
      <>
        <AuthHeading kick="Account" title="This link won't work" />
        <EmptyState
          title="Expired or already used"
          body={phase.message}
          action={
            <div className="flex gap-2">
              <Button asChild variant="primary">
                <Link href="/forgot-password">Request a new link</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/sign-in">Sign in</Link>
              </Button>
            </div>
          }
        />
      </>
    );
  }

  if (phase.kind === "done") {
    return <AuthHeading kick="All set" title="Signing you in…" />;
  }

  return (
    <>
      <AuthHeading
        kick={isInvite ? "You've been invited" : "Account"}
        title={isInvite ? "Set your password" : "Choose a new password"}
        sub={
          isInvite
            ? "A super admin created this staff account for you. Set a password to activate it."
            : "Pick something you haven't used elsewhere."
        }
      />

      <MetaList className="mb-5">
        <MetaRow label="Account">{phase.email}</MetaRow>
      </MetaList>

      <form onSubmit={onSubmit} method="post" noValidate className="flex flex-col gap-4">
        <Field label="New password" htmlFor="password" error={form.formState.errors.password?.message} hint="8+ characters, a capital and a number.">
          <Input id="password" type="password" autoComplete="new-password" autoFocus invalid={Boolean(form.formState.errors.password)} {...form.register("password")} />
        </Field>
        <Field label="Confirm password" htmlFor="confirmPassword" error={form.formState.errors.confirmPassword?.message}>
          <Input id="confirmPassword" type="password" autoComplete="new-password" invalid={Boolean(form.formState.errors.confirmPassword)} {...form.register("confirmPassword")} />
        </Field>
        {formError ? (
          <div role="alert" className="rounded-md px-3 py-2.5 text-[13px] shadow-[inset_0_0_0_1px_var(--color-danger)]">
            {formError}
          </div>
        ) : null}
        <Button type="submit" variant="primary" size="lg" block loading={form.formState.isSubmitting} className="mt-1">
          {isInvite ? "Activate account" : "Save password"}
        </Button>
      </form>
    </>
  );
}
