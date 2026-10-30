"use client";

import Link from "next/link";
import { useAuth } from "@/components/providers";
import { UserMenu } from "./user-menu";

/** Children render only for visitors with no session. */
export const SignedOutOnly = ({ children }: { children: React.ReactNode }) => {
  const { status } = useAuth();
  return status === "signed-out" ? <>{children}</> : null;
};

/**
 * Account controls shown in a public nav: ghost "Sign in" beside a filled
 * "Create account" when signed out, the account menu otherwise.
 *
 * `variant="landing"` is for the reference-ported `/` nav only
 * (`src/app/_landing/landing-experience.tsx`) — it swaps the product `.btn`
 * classes for the reference's own `.minimal-login`/`.action-button` classes
 * so the control reads as part of that page's reference-exact nav instead of
 * a mismatched product button; the underlying auth logic is identical.
 */
export const PublicAuthControls = ({ variant = "default" }: { variant?: "default" | "landing" }) => {
  const { status } = useAuth();

  if (status === "loading") return <div className="h-9 w-[180px]" aria-hidden />;

  if (status === "signed-out") {
    if (variant === "landing") {
      return (
        <>
          <Link href="/sign-in" className="minimal-login">
            Sign in
          </Link>
          <Link href="/create-account" className="action-button">
            <span>Get started</span>
          </Link>
        </>
      );
    }
    return (
      <>
        <Link href="/sign-in" className="btn btn-ghost">
          Sign in
        </Link>
        <Link href="/create-account" className="btn btn-primary">
          Create account
        </Link>
      </>
    );
  }

  return <UserMenu variant="student" />;
};
