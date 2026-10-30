"use client";

import Link from "next/link";
import { Page } from "@/components/shell/student-shell";
import { useMyEntries } from "@/components/student/use-my-entries";
import { InvitationCard, TeamCard } from "@/components/student/team-panel";
import { JoinTeam } from "@/components/student/join-team";
import { EmptyState, Kick, Skeleton } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";

/**
 * Teams — in the tap bar of every student screen in the canvas, but never
 * drawn. A team is a registration with more than one member. Invitations
 * addressed to me come first (they need an answer); then every team I'm on,
 * with the leader's controls where I'm the leader.
 */
export default function TeamsPage() {
  const { entries, isPending } = useMyEntries();
  const teamEntries = entries.filter((e) => e.registration.type === "team" && e.registration.status !== "cancelled");

  const invitations = teamEntries.filter((e) => e.invited);
  const teams = teamEntries.filter((e) => !e.invited);

  return (
    <Page className="max-w-[720px] pb-8 pt-2">
      <h4 className="mb-1">Teams</h4>
      <div className="mb-4 text-[12.5px] text-neutral-500">Every team entry you’re part of, and who’s on it.</div>

      <JoinTeam className="mb-6 border-b border-divider pb-5" />

      {isPending && entries.length === 0 ? (
        <>
          <Skeleton className="mb-3 h-32" />
          <Skeleton className="h-32" />
        </>
      ) : teamEntries.length === 0 ? (
        <EmptyState
          title="No teams yet"
          body="Register for a team event and add your teammates by email. They'll appear here, and each gets their own ticket and certificate."
          action={
            <Button asChild variant="primary">
              <Link href="/explore">Find a team event</Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {invitations.length ? (
            <section>
              <Kick className="mb-2">Invitations · {invitations.length}</Kick>
              <div className="flex flex-col gap-3">
                {invitations.map((entry) => (
                  <InvitationCard key={entry.registration.id} entry={entry} />
                ))}
              </div>
            </section>
          ) : null}
          {teams.length ? (
            <section>
              {invitations.length ? <Kick className="mb-2">Your teams</Kick> : null}
              <div className="flex flex-col gap-3">
                {teams.map((entry) => (
                  <TeamCard key={entry.registration.id} entry={entry} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </Page>
  );
}
