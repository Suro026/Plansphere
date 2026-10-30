"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/primitives";

/**
 * Firebase's action-link handler.
 *
 * Firebase sends every emailed link (reset, verify, invite) to one URL with a
 * `mode` query. This page reads it and forwards to the screen that handles
 * that mode, so the Console's "Action URL" setting can point here and stay
 * pointed here.
 *
 * Set it in Firebase Console → Authentication → Templates → Customize action
 * URL to `${NEXT_PUBLIC_APP_URL}/auth/action`.
 */
export default function AuthActionPage() {
  const router = useRouter();
  const params = useSearchParams();

  React.useEffect(() => {
    const mode = params.get("mode");
    const code = params.get("oobCode") ?? "";
    const continueUrl = params.get("continueUrl") ?? "";

    let next: URL | null = null;
    try {
      next = continueUrl ? new URL(continueUrl) : null;
    } catch {
      next = null;
    }
    const invite = next?.searchParams.get("invite") === "1" ? "&invite=1" : "";

    switch (mode) {
      case "resetPassword":
        router.replace(`/set-password?oobCode=${encodeURIComponent(code)}${invite}`);
        break;
      case "verifyEmail":
        router.replace(`/verify-email?oobCode=${encodeURIComponent(code)}`);
        break;
      default:
        router.replace("/sign-in");
    }
  }, [params, router]);

  return (
    <div aria-busy>
      <Skeleton className="mb-3 h-3 w-24" />
      <Skeleton className="mb-8 h-9 w-64" />
      <Skeleton className="h-10" />
    </div>
  );
}
