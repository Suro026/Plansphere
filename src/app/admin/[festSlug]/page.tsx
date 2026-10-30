import { redirect } from "next/navigation";

export default async function AdminFestIndex({ params }: { params: Promise<{ festSlug: string }> }) {
  const { festSlug } = await params;
  redirect(`/admin/${festSlug}/overview`);
}
