"use client";

import { useParams } from "next/navigation";
import { EventProvider } from "@/components/admin/event-context";

export default function AdminEventLayout({ children }: { children: React.ReactNode }) {
  const { eventSlug } = useParams<{ eventSlug: string }>();
  return <EventProvider eventSlug={eventSlug}>{children}</EventProvider>;
}
