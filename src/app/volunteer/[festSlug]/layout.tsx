"use client";

import { useParams } from "next/navigation";
import { VolunteerFestProvider, VolunteerShell } from "@/components/shell/volunteer-shell";

export default function VolunteerFestLayout({ children }: { children: React.ReactNode }) {
  const { festSlug } = useParams<{ festSlug: string }>();
  return (
    <VolunteerFestProvider festSlug={festSlug}>
      <VolunteerShell>{children}</VolunteerShell>
    </VolunteerFestProvider>
  );
}
