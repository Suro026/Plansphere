"use client";

import { useAuth } from "@/components/providers";
import { Brand } from "@/components/shell/brand";
import { UserMenu } from "@/components/shell/user-menu";
import { StaffProfileForm } from "@/components/admin/staff-profile-form";
import { PageHeading } from "@/components/ui/primitives";

/** An admin's own profile — avatar, name, phone, designation, department. */
export default function AdminProfilePage() {
  const { session } = useAuth();
  const roleLabel = session?.role === "super_admin" ? "SUPER ADMIN" : "ADMIN";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav className="nav mx-auto w-full max-w-[1180px] px-5 py-3.5 lg:px-8" aria-label="Profile">
          <Brand href="/admin" role={roleLabel} />
          <UserMenu variant="admin" />
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-[560px] flex-1 px-5 pb-10 pt-7">
        <PageHeading kick="Account" title="Your profile" sub={session?.email ?? ""} className="mb-5" />
        <StaffProfileForm />
      </main>
    </div>
  );
}
