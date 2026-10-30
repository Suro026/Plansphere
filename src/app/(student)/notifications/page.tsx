"use client";

import { Page } from "@/components/shell/student-shell";
import { NotificationCenter } from "@/components/shell/notifications";

/** Everything the bell shows, uncapped, grouped by day. Deep-linked from emails. */
export default function NotificationsPage() {
  return (
    <Page className="max-w-[720px] pb-8 pt-2">
      <h4 className="mb-1">Notifications</h4>
      <div className="mb-4 text-[12.5px] text-neutral-500">Registrations, teams, results, certificates and messages from organizers.</div>
      <NotificationCenter />
    </Page>
  );
}
