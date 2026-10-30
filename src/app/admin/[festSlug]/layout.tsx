"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { AdminShell, FestProvider } from "@/components/shell/admin-shell";

/** Resolves the fest in the URL and wraps every admin page in the shell. */
export default function AdminFestLayout({ children }: { children: React.ReactNode }) {
  const { festSlug } = useParams<{ festSlug: string }>();

  return (
    <FestProvider festSlug={festSlug}>
      <AdminShell>{children}</AdminShell>
    </FestProvider>
  );
}
