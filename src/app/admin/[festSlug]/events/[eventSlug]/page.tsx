import { redirect } from "next/navigation";

export default async function AdminEventIndex({ params }: { params: Promise<{ festSlug: string; eventSlug: string }> }) {
  const { festSlug, eventSlug } = await params;
  redirect(`/admin/${festSlug}/events/${eventSlug}/settings`);
}
