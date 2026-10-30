"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { GuardSkeleton } from "@/components/shell/require-role";

export default function SuperAuditRedirect() {
  const router = useRouter();
  React.useEffect(() => {
    router.replace("/admin/platform/audit");
  }, [router]);
  return <GuardSkeleton />;
}
