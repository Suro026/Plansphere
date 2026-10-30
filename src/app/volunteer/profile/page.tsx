"use client";

import { useAuth } from "@/components/providers";
import { Brand } from "@/components/shell/brand";
import { UserMenu } from "@/components/shell/user-menu";
import { StaffProfileForm } from "@/components/admin/staff-profile-form";
import { PageHeading } from "@/components/ui/primitives";

/** A volunteer's own profile — avatar, name, phone, designation. */
export default function VolunteerProfilePage() {
  const { session } = useAuth();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav className="nav mx-auto w-full max-w-[1180px] px-[18px] py-3.5 sm:px-6" aria-label="Profile">
          <Brand href="/volunteer" role="VOLUNTEER" />
          <UserMenu variant="admin" />
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-[560px] flex-1 px-[18px] pb-10 pt-7 sm:px-6">
        <PageHeading kick="Account" title="Your profile" sub={session?.email ?? ""} className="mb-5" />
        <StaffProfileForm />
      </main>
    </div>
  );
}
