import { z } from "zod";
import type { MatchConfig } from "@/core/models/match";
import { generateKnockoutBracket, generateRoundRobin, type BracketMatchDraft } from "@/core/services/bracket";
import { getScoringEngine } from "@/core/services/scoring";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact } from "@/server/serialize";

/**
 * POST /api/admin/events/[id]/bracket — turns confirmed entries into a
 * bracket.
 *
 * Only knockout and round-robin auto-generate: a swiss draw is paired round
 * by round from standings that do not exist until matches have been played,
 * and "custom" means the coordinator is building fixtures by hand — neither
 * has a single well-defined starting bracket the way a knockout or a
 * round-robin does. Both of those tournament types still get their matches
 * created one at a time through `/api/admin/matches`.
 *
 * Regenerating replaces whatever bracket already exists for the event —
 * every one of its matches and their timelines are deleted first, so this
 * is only safe to call before anyone has started scoring.
 */
const bodySchema = z.object({ tournamentType: z.enum(["knockout", "round_robin"]) });

export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "match:manage");
  const { id: eventId } = await context.params;
  if (!eventId) throw ApiError.badRequest("Missing event id.");

  const { tournamentType } = await readBody(request, bodySchema);

  const db = adminDb();
  const eventRef = db.collection(COLLECTIONS.events).doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");
  const event = eventSnap.data()!;
  requireFestAccess(caller, String(event.festId), eventId);

  if (!event.liveEnabled) throw ApiError.unprocessable("Turn on live mode for this event before generating a bracket.");
  if (!event.sportType) throw ApiError.unprocessable("Set a sport for this event before generating a bracket.");

  const existingMatches = await db.collection(COLLECTIONS.matches).where("eventId", "==", eventId).get();
  if (existingMatches.docs.some((doc) => doc.data().status === "live" || doc.data().status === "completed")) {
    throw ApiError.unprocessable("Some matches have already started or finished — regenerating now would erase real results.");
  }

  const regSnap = await db.collection(COLLECTIONS.registrations).where("eventId", "==", eventId).where("status", "==", "confirmed").get();
  const participants = regSnap.docs.map((doc) => {
    const r = doc.data();
    return { registrationId: doc.id, name: String(r.teamName ?? r.userName ?? "Entry") };
  });

  if (participants.length < 2) throw ApiError.unprocessable("At least two confirmed entries are needed to generate a bracket.");

  const drafts: BracketMatchDraft[] = tournamentType === "knockout" ? generateKnockoutBracket(participants) : generateRoundRobin(participants);

  // Clear the previous bracket — its matches and their timelines — before
  // writing the new one.
  if (!existingMatches.empty) {
    const matchIds = existingMatches.docs.map((doc) => doc.id);
    for (let i = 0; i < matchIds.length; i += 400) {
      const batch = db.batch();
      for (const matchId of matchIds.slice(i, i + 400)) batch.delete(db.collection(COLLECTIONS.matches).doc(matchId));
      await batch.commit();
    }
    for (let i = 0; i < matchIds.length; i += 30) {
      const logSnap = await db.collection(COLLECTIONS.matchLog).where("matchId", "in", matchIds.slice(i, i + 30)).get();
      if (logSnap.empty) continue;
      const batch = db.batch();
      for (const doc of logSnap.docs) batch.delete(doc.ref);
      await batch.commit();
    }
  }

  const matchConfig = (event.matchConfig ?? { durationType: "points", maxPlayers: 11 }) as MatchConfig;
  // Every match starts from its sport engine's own state (cards, overs, sets…), not an empty one.
  const startingScore = getScoringEngine(String(event.sportType)).initialState(matchConfig);
  const refs = drafts.map(() => db.collection(COLLECTIONS.matches).doc());
  const idFor = new Map<string, string>();
  drafts.forEach((draft, i) => idFor.set(`${draft.round}:${draft.matchIndex}`, refs[i]!.id));

  for (let i = 0; i < drafts.length; i += 400) {
    const batch = db.batch();
    for (const [j, draft] of drafts.slice(i, i + 400).entries()) {
      const idx = i + j;
      const nextMatchId =
        draft.nextMatchRound !== undefined && draft.nextMatchIndex !== undefined ? idFor.get(`${draft.nextMatchRound}:${draft.nextMatchIndex}`) : undefined;
      batch.set(
        refs[idx]!,
        compact({
          id: refs[idx]!.id,
          festId: event.festId,
          eventId,
          round: draft.round,
          roundLabel: draft.roundLabel,
          matchIndex: draft.matchIndex,
          homeTeam: draft.homeTeam,
          awayTeam: draft.awayTeam,
          winner: draft.winner,
          status: draft.winner ? "completed" : "upcoming",
          sportType: event.sportType,
          matchConfig,
          score: { ...startingScore, isComplete: Boolean(draft.winner) },
          nextMatchId,
          nextMatchSlot: draft.nextMatchSlot,
          paused: false,
          finishedAt: draft.winner ? FieldValue.serverTimestamp() : undefined,
          createdBy: caller.uid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }),
      );
    }
    await batch.commit();
  }

  if (event.tournamentType !== tournamentType) {
    await eventRef.update({ tournamentType, updatedAt: FieldValue.serverTimestamp() });
  }

  await audit(caller, {
    action: "bracket_generated",
    summary: `${drafts.length} match${drafts.length === 1 ? "" : "es"} generated (${tournamentType}) for "${event.title}"`,
    festId: String(event.festId),
    eventId,
    subjectType: "event",
    subjectId: eventId,
  });

  return ok({ created: drafts.length });
});
