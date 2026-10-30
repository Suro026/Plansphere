"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { emailSchema } from "@/core/models/common";
import { passwordsMatch, signInSchema, studentSignUpFields, type SignIn } from "@/core/models/user";
import { AuthError } from "@/core/services/auth-service";
import { useAuth, useRepositories } from "@/components/providers";
import { postAuthDestination } from "@/components/auth/destination";
import { Button } from "@/components/ui/button";
import { CheckOption, Field, Input, NativeSelect } from "@/components/ui/field";
import { MetaList, MetaRow, Note } from "@/components/ui/primitives";

/**
 * The four forms behind the tabs on /sign-in.
 *
 * Sign-in is *one* form and one code path for every role — a student and a
 * super admin submit the same request; where they land afterwards is decided
 * by the claim on the token they get back, never by which tab they used. The
 * two sign-in tabs differ only in the help text around the form, because the
 * questions people arrive with are different ("where do I sign up?" versus
 * "who gives me an account?").
 */

const Error_ = ({ message }: { message: string | null }) =>
  message ? (
    <p role="alert" className="text-[13px] text-danger">
      {message}
    </p>
  ) : null;

/* ───────────── sign in ───────────── */

export const SignInForm = ({ audience, next }: { audience: "student" | "organizer"; next: string }) => {
  const { auth, profile } = useAuth();
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<SignIn>({ resolver: zodResolver(signInSchema), defaultValues: { email: "", password: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const session = await auth.signIn(values.email, values.password);
      router.replace(postAuthDestination(session, profile, next));
    } catch (error) {
      setFormError(error instanceof AuthError ? error.message : "Something went wrong. Please try again.");
    }
  });

  const err = form.formState.errors;

  return (
    <form onSubmit={onSubmit} method="post" noValidate className="flex flex-col gap-4">
      <Field label="Email" htmlFor={`${audience}-email`} error={err.email?.message}>
        <Input
          id={`${audience}-email`}
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder={audience === "student" ? "you@college.edu" : "you@college.edu"}
          invalid={Boolean(err.email)}
          {...form.register("email")}
        />
      </Field>

      <Field
        label="Password"
        htmlFor={`${audience}-password`}
        error={err.password?.message}
        labelEnd={
          <Link href="/sign-in?tab=forgot" className="text-[12px] text-neutral-500 no-underline hover:text-accent">
            Forgot?
          </Link>
        }
      >
        <Input id={`${audience}-password`} type="password" autoComplete="current-password" invalid={Boolean(err.password)} {...form.register("password")} />
      </Field>

      <Error_ message={formError} />

      <Button type="submit" variant="primary" size="lg" block loading={form.formState.isSubmitting}>
        Sign in
      </Button>

      {audience === "student" ? (
        <p className="text-[13px] text-neutral-500">
          New here?{" "}
          <Link href="/sign-in?tab=create" className="text-accent-300">
            Create an account
          </Link>
          .
        </p>
      ) : (
        <Note title="Organizer and volunteer accounts are created for you">
          Admins and super admins are set up by a super admin; volunteers by their fest&apos;s admin. You will get an
          email with a link and a temporary password, and you will be asked to choose your own the first time you sign
          in. There is no organizer sign-up.
        </Note>
      )}
    </form>
  );
};

/* ───────────── create account (students only) ───────────── */

const signUpSchema = studentSignUpFields
  .extend({ consent: z.literal(true, { message: "You need to agree before continuing" }) })
  .refine((data) => data.password === data.confirmPassword, passwordsMatch);

type SignUpValues = z.input<typeof signUpSchema>;

export const CreateAccountForm = ({ next }: { next: string }) => {
  const { auth } = useAuth();
  const repos = useRepositories();
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: "", email: "", phone: "", college: "", studentId: "", department: "", password: "", confirmPassword: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const session = await auth.signUp(values.email, values.password, values.name);

      await repos.users.createStudentProfile({
        id: session.uid,
        email: session.email,
        name: values.name,
        phone: values.phone,
        studentId: values.studentId,
        college: values.college,
        department: values.department || undefined,
        year: values.year ? Number(values.year) : undefined,
        emailVerified: false,
      });

      // Profile exists now, so the verification email can carry the name and
      // go through our mailer. A failure here is not fatal: the verify-email
      // screen offers "send again".
      await auth.sendVerificationEmail().catch(() => undefined);

      // If a teammate entered this address before the account existed, claim
      // those entries now so certificates can reach the right person.
      repos.registrations.linkMemberAccountsByEmail().catch(() => undefined);

      router.replace(next ? `/verify-email?next=${encodeURIComponent(next)}` : "/verify-email");
    } catch (error) {
      setFormError(error instanceof AuthError ? error.message : "Something went wrong. Please try again.");
    }
  });

  const err = form.formState.errors;

  return (
    <form onSubmit={onSubmit} method="post" noValidate className="flex flex-col gap-4">
      <Field label="Full name" htmlFor="su-name" error={err.name?.message} hint="As it should appear on certificates.">
        <Input id="su-name" autoComplete="name" invalid={Boolean(err.name)} {...form.register("name")} />
      </Field>

      <Field label="Email" htmlFor="su-email" error={err.email?.message}>
        <Input id="su-email" type="email" autoComplete="email" inputMode="email" placeholder="you@college.edu" invalid={Boolean(err.email)} {...form.register("email")} />
      </Field>

      <Field label="Phone" htmlFor="su-phone" error={err.phone?.message}>
        <Input id="su-phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+91" invalid={Boolean(err.phone)} {...form.register("phone")} />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="College" htmlFor="su-college" error={err.college?.message}>
          <Input id="su-college" autoComplete="organization" invalid={Boolean(err.college)} {...form.register("college")} />
        </Field>
        <Field label="College ID (optional)" htmlFor="su-studentId" error={err.studentId?.message}>
          <Input id="su-studentId" placeholder="RA2211003010" invalid={Boolean(err.studentId)} {...form.register("studentId")} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Department (optional)" htmlFor="su-department" error={err.department?.message}>
          <Input id="su-department" placeholder="CSE" {...form.register("department")} />
        </Field>
        <Field label="Year (optional)" htmlFor="su-year" error={err.year?.message}>
          <NativeSelect id="su-year" {...form.register("year", { setValueAs: (v) => (v === "" ? undefined : Number(v)) })}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5, 6].map((y) => (
              <option key={y} value={y}>
                Year {y}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Password" htmlFor="su-password" error={err.password?.message} hint="8+ characters, a capital and a number.">
          <Input id="su-password" type="password" autoComplete="new-password" invalid={Boolean(err.password)} {...form.register("password")} />
        </Field>
        <Field label="Confirm password" htmlFor="su-confirm" error={err.confirmPassword?.message}>
          <Input id="su-confirm" type="password" autoComplete="new-password" invalid={Boolean(err.confirmPassword)} {...form.register("confirmPassword")} />
        </Field>
      </div>

      <CheckOption
        label="I agree to the Terms and the Privacy Policy"
        description="We store your name, college and contact details to run the fests you register for."
        {...form.register("consent")}
      />
      {err.consent ? <Error_ message={err.consent.message ?? null} /> : null}

      <Error_ message={formError} />

      <Button type="submit" variant="primary" size="lg" block loading={form.formState.isSubmitting}>
        Create account
      </Button>

      <p className="text-[13px] text-neutral-500">
        Already have one?{" "}
        <Link href="/sign-in" className="text-accent-300">
          Sign in
        </Link>
        .
      </p>
    </form>
  );
};

/* ───────────── forgot password ───────────── */

export const ForgotPasswordForm = () => {
  const { auth } = useAuth();
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  const schema = z.object({ email: emailSchema });
  const form = useForm<z.input<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setFormError(null);
    try {
      await auth.sendPasswordReset(email);
      setSentTo(email);
    } catch (error) {
      setFormError(error instanceof AuthError ? error.message : "Something went wrong. Please try again.");
    }
  });

  if (sentTo) {
    return (
      <div>
        <MetaList className="mb-5">
          <MetaRow label="Sent to">{sentTo}</MetaRow>
          <MetaRow label="Expires">In one hour</MetaRow>
          <MetaRow label="Nothing there?">Check spam, or try again</MetaRow>
        </MetaList>
        <p className="mb-5 max-w-[44ch] text-[13px] text-neutral-500">
          If that address has an account, the link is on its way. We say the same thing either way, so nobody can use
          this page to find out who has signed up.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setSentTo(null)}>
            Use a different email
          </Button>
          <Button asChild variant="ghost">
            <Link href="/sign-in">Back to sign in</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} method="post" noValidate className="flex flex-col gap-4">
      <Field label="Email" htmlFor="fp-email" error={form.formState.errors.email?.message}>
        <Input id="fp-email" type="email" autoComplete="email" inputMode="email" invalid={Boolean(form.formState.errors.email)} {...form.register("email")} />
      </Field>
      <Error_ message={formError} />
      <Button type="submit" variant="primary" size="lg" block loading={form.formState.isSubmitting}>
        Send reset link
      </Button>
      <p className="text-[13px] text-neutral-500">
        Students, volunteers and admins all reset the same way.{" "}
        <Link href="/sign-in" className="text-accent-300">
          Back to sign in
        </Link>
        .
      </p>
    </form>
  );
};
