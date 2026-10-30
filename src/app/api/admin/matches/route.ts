import { createArenaMatchSchema, type MatchConfig } from "@/core/models/match";
import { getScoringEngine } from "@/core/services/scoring";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";

/**
 * POST /api/admin/matches — a single, manually created match.
 *
 * The knockout and round-robin generators build a whole bracket at once;
 * swiss and custom tournaments (and any correction to a generated bracket)
 * add fixtures one at a time here instead.
 */
export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "match:manage");
  const input = await readBody(request, createArenaMatchSchema);
  requireFestAccess(caller, input.festId, input.eventId);

  const db = adminDb();
  const eventSnap = await db.collection(COLLECTIONS.events).doc(input.eventId).get();
  if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");
  const event = eventSnap.data()!;
  if (String(event.festId) !== input.festId) throw ApiError.badRequest("That event does not belong to this fest.");
  if (!event.sportType) throw ApiError.unprocessable("Set a sport for this event before adding matches.");

  let arenaName: string | undefined;
  if (input.arenaId) {
    const arenaSnap = await db.collection(COLLECTIONS.arenas).doc(input.arenaId).get();
    if (!arenaSnap.exists || String(arenaSnap.data()?.festId) !== input.festId) throw ApiError.badRequest("That arena does not belong to this fest.");
    arenaName = String(arenaSnap.data()?.name ?? "");
  }

  const matchConfig = (event.matchConfig ?? { durationType: "points", maxPlayers: 11 }) as MatchConfig;
  const countSnap = await db.collection(COLLECTIONS.matches).where("eventId", "==", input.eventId).count().get();

  const ref = db.collection(COLLECTIONS.matches).doc();
  await ref.set(
    compact({
      id: ref.id,
      festId: input.festId,
      eventId: input.eventId,
      round: input.round ?? 1,
      roundLabel: input.roundLabel ?? "Fixture",
      matchIndex: input.matchIndex ?? countSnap.data().count,
      homeTeam: input.homeTeam ?? null,
      awayTeam: input.awayTeam ?? null,
      arenaId: input.arenaId,
      arenaName,
      startTime: input.startTime,
      status: "upcoming",
      paused: false,
      sportType: event.sportType,
      matchConfig,
      // The sport's own starting state, not an empty one: its engine reads keys (cards, overs, sets) from it.
      score: getScoringEngine(String(event.sportType)).initialState(matchConfig),
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );

  await audit(caller, {
    action: "match_created",
    summary: `Match added to "${event.title}"`,
    festId: input.festId,
    eventId: input.eventId,
    subjectType: "match",
    subjectId: ref.id,
  });

  const snap = await ref.get();
  return ok({ match: docToJson(snap) }, 201);
});
