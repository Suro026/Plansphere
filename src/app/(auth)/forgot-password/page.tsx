"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

/** Kept as a redirect into the forgot-password tab of /sign-in. */
export default function ForgotPasswordRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  React.useEffect(() => {
    const query = new URLSearchParams(params.toString());
    query.set("tab", "forgot");
    router.replace(`/sign-in?${query}`);
  }, [params, router]);

  return null;
}
