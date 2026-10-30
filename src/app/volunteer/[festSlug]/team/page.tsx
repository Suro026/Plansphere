"use client";

import * as React from "react";
import { useVolunteerFest } from "@/components/shell/volunteer-shell";
import { useFestShifts } from "@/components/admin/hooks";
import { Avatar } from "@/components/ui/overlays";
import { EmptyState, Kick, Skeleton, Tag } from "@/components/ui/primitives";
import { SHIFT_DUTY_LABELS, shiftPhase } from "@/core/models/shift";

/** Team — who else is on today, by post. Read-only; the roster lives on the admin side. */
export default function VolunteerTeamPage() {
  const { fest } = useVolunteerFest();
  const shifts = useFestShifts(fest.id);
  const now = React.useMemo(() => new Date(), [shifts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = now.toISOString().slice(0, 10);

  const byPost = React.useMemo(() => {
    const m = new Map<string, typeof todays>();
    const todays = (shifts.data ?? []).filter((s) => s.date === today && !s.cancelled);
    for (const s of todays) m.set(s.post || "Unassigned", [...(m.get(s.post || "Unassigned") ?? []), s]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shifts.data, today]);

  return (
    <div className="mx-auto w-full max-w-[720px] px-[18px] pt-2.5 sm:px-6 sm:pt-6">
      <h4 className="mb-1">Team</h4>
      <div className="mb-4 text-[12.5px] text-neutral-500">Everyone rostered today, by post.</div>
      {shifts.loading ? (
        <Skeleton className="h-48" />
      ) : byPost.length === 0 ? (
        <EmptyState title="Nobody rostered today" body="Shifts show up here once the admins assign posts for the day." />
      ) : (
        <div className="flex flex-col gap-4">
          {byPost.map(([post, list]) => (
            <div key={post}>
              <Kick className="mb-2">{post}</Kick>
              <div className="flex flex-col gap-2">
                {list
                  .sort((a, b) => a.startTime.localeCompare(b.startTime))
                  .map((s) => {
                    const p = shiftPhase(s, now);
                    return (
                      <div key={s.id} className="flex items-center gap-2.5">
                        <Avatar name={s.userName} size={28} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px]">{s.userName}</div>
                          <div className="text-[11px] text-neutral-500">
                            {s.startTime}–{s.endTime} · {SHIFT_DUTY_LABELS[s.duty].split(" ")[0]}
                          </div>
                        </div>
                        {p === "active" ? <Tag tone="accent">On shift</Tag> : p === "upcoming" ? <Tag tone="neutral">Later</Tag> : <Tag tone="neutral">Done</Tag>}
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
