"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { hasAtLeast } from "@/core/models/user";
import { useAuth } from "@/components/providers";
import { useManagedFests } from "@/components/shell/admin-shell";
import { GuardSkeleton } from "@/components/shell/require-role";
import { Brand } from "@/components/shell/brand";
import { EmptyState } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";

/**
 * /admin — the front door. Sends staff to the fest they manage; a super admin
 * with several fests goes to the list; an account scoped to nothing gets told
 * so plainly rather than a blank dashboard.
 */
export default function AdminIndexPage() {
  const { session } = useAuth();
  const router = useRouter();
  const managed = useManagedFests();

  React.useEffect(() => {
    if (!managed.data || !session) return;
    const fests = managed.data;
    if (fests.length === 1 && fests[0]) {
      router.replace(`/admin/${fests[0].slug}/overview`);
    } else if (fests.length > 1) {
      if (hasAtLeast(session.role, "super_admin")) router.replace("/admin/fests");
      else router.replace(`/admin/${fests[0]!.slug}/overview`);
    } else if (hasAtLeast(session.role, "super_admin")) {
      router.replace("/admin/fests");
    }
  }, [managed.data, session, router]);

  if (managed.isPending || (managed.data && managed.data.length > 0)) return <GuardSkeleton />;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav className="nav mx-auto w-full max-w-[1180px] px-5 py-3.5 lg:px-8" aria-label="Admin">
          <Brand href="/admin" role="ADMIN" />
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-[720px] px-5 py-16">
        <EmptyState
          title="No fest assigned yet"
          body="Your account is staff, but it isn't scoped to any fest. A super admin adds fests to your scope from Staff → Edit."
          action={
            <Button asChild variant="secondary">
              <Link href="/explore">Back to the student side</Link>
            </Button>
          }
        />
      </main>
    </div>
  );
}
