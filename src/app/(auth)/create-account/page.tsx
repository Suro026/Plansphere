"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Sign-up now lives on the single authentication page as a tab. This route
 * stays so existing links and bookmarks keep working.
 */
export default function CreateAccountRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  React.useEffect(() => {
    const query = new URLSearchParams(params.toString());
    query.set("tab", "create");
    router.replace(`/sign-in?${query}`);
  }, [params, router]);

  return null;
}
