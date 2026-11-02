"use client";

import * as React from "react";
import { toast } from "sonner";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useRepositories } from "@/components/providers";
import { useArenaVolunteers, useAssignArenaVolunteer } from "@/components/admin/arena-volunteers-api";
import { useFestShifts } from "@/components/admin/hooks";
import { useFestArenas } from "@/components/live/hooks";
import type { Arena } from "@/core/models/arena";
import { ApiClientError } from "@/data/api-client";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { EmptyState, Kick, MetaList, MetaRow, PageHeading, Panel, Skeleton, Tag } from "@/components/ui/primitives";

/**
 * 7 — Arena management: the places a fest's matches happen. A volunteer
 * scores only the arena their shift assigns them to, so this page is also
 * where that assignment is made — a `Shift` with duty "scoring" and `post`
 * set to the arena's id.
 */
export default function ArenasPage() {
  const { fest } = useFest();
  const repos = useRepositories();
  const arenas = useFestArenas(fest.id);
  const volunteerList = useArenaVolunteers(fest.id);
  const assignToArena = useAssignArenaVolunteer();
  const shifts = useFestShifts(fest.id);

  const [name, setName] = React.useState("");
  const [location, setLocation] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  // Everyone who could score here: event-role volunteers with the scoring duty as well as fest-scoped ones. The server decides
  // who qualifies (and applies the same rule when it saves), because an event role is not readable from the browser.
  const volunteers = volunteerList.data ?? [];

  const createArena = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await repos.arenas.create({ festId: fest.id, name: name.trim(), location: location.trim() || undefined });
      setName("");
      setLocation("");
      toast.success("Arena created");
    } catch {
      toast.error("Couldn't create the arena");
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (arena: Arena) => {
    try {
      await repos.arenas.update(arena.id, { active: !arena.active });
    } catch {
      toast.error("Couldn't update the arena");
    }
  };

  const removeArena = async (arena: Arena) => {
    try {
      await repos.arenas.delete(arena.id);
      toast.success("Arena removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove the arena");
    }
  };

  const assignedTo = React.useCallback(
    (arenaId: string) => (shifts.data ?? []).filter((s) => s.duty === "scoring" && s.post === arenaId && !s.cancelled),
    [shifts.data],
  );

  const [assigning, setAssigning] = React.useState<Record<string, string>>({});
  const assignVolunteer = async (arena: Arena) => {
    const userId = assigning[arena.id];
    const volunteer = volunteers.find((v) => v.id === userId);
    if (!volunteer) return;
    try {
      const result = await assignToArena.mutateAsync({ arenaId: arena.id, userId: volunteer.id });
      toast.success(result.alreadyAssigned ? `${volunteer.name} was already assigned to ${arena.name}` : `${volunteer.name} assigned to ${arena.name}`);
      setAssigning((a) => ({ ...a, [arena.id]: "" }));
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : "Couldn't assign that volunteer");
    }
  };

  return (
    <AdminPage className="pb-9 pt-[26px]">
      <PageHeading kick={fest.name} title="Arenas" sub="Where matches happen, and who scores at each one." className="mb-6" />

      <Panel className="mb-6 p-5">
        <Kick className="mb-3">New arena</Kick>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Arena A" />
          </Field>
          <Field label="Location (optional)">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="North lawn" />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" disabled={creating || !name.trim()} onClick={() => void createArena()}>
              {creating ? "Adding…" : "Add arena"}
            </Button>
          </div>
        </div>
      </Panel>

      {arenas.loading || volunteerList.isPending ? (
        <Skeleton className="h-64" />
      ) : (arenas.data ?? []).length === 0 ? (
        <EmptyState title="No arenas yet" body="Add one above — a live event needs at least one to group matches by." />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {(arenas.data ?? []).map((arena) => (
            <Panel key={arena.id} className="p-5">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[15px] font-medium">{arena.name}</div>
                <Tag tone={arena.active ? "accent" : "neutral"}>{arena.active ? "Active" : "Inactive"}</Tag>
              </div>
              {arena.location ? <div className="mb-3 text-[12px] text-neutral-500">{arena.location}</div> : null}

              <Kick className="mb-1.5">Assigned volunteers</Kick>
              {assignedTo(arena.id).length === 0 ? (
                <div className="mb-3 text-[12.5px] text-neutral-500">Nobody assigned yet.</div>
              ) : (
                <MetaList className="mb-3">
                  {assignedTo(arena.id).map((s) => (
                    <MetaRow key={s.id} label={s.userName}>
                      —
                    </MetaRow>
                  ))}
                </MetaList>
              )}

              {volunteers.length > 0 ? (
                <div className="flex gap-2">
                  <NativeSelect className="flex-1" value={assigning[arena.id] ?? ""} onChange={(e) => setAssigning((a) => ({ ...a, [arena.id]: e.target.value }))}>
                    <option value="">Assign a volunteer…</option>
                    {volunteers.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} · {v.email}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button variant="secondary" disabled={!assigning[arena.id]} onClick={() => void assignVolunteer(arena)}>
                    Assign
                  </Button>
                </div>
              ) : (
                <div className="text-[12px] text-neutral-500">{volunteerList.isError ? "Couldn't load the volunteers." : "No volunteers who can score yet. Add one from the Team page with the scoring duty."}</div>
              )}

              <div className="mt-4 flex gap-2">
                <Button variant="ghost" onClick={() => void toggleActive(arena)}>
                  {arena.active ? "Mark inactive" : "Mark active"}
                </Button>
                <Button variant="ghost" onClick={() => void removeArena(arena)}>
                  Remove
                </Button>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </AdminPage>
  );
}
