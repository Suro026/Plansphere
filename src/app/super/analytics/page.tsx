"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { GuardSkeleton } from "@/components/shell/require-role";

export default function SuperAnalyticsRedirect() {
  const router = useRouter();
  React.useEffect(() => {
    router.replace("/admin/platform/analytics");
  }, [router]);
  return <GuardSkeleton />;
}
