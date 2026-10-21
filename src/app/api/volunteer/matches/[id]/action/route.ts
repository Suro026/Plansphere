import { z } from "zod";
import { isFinalMatch, matchSideSchema, matchWinnerName, scoreActionSchema, type Match, type MatchSide } from "@/core/models/match";
import type { MatchLogEntry } from "@/core/models/match-log";
import { activeLog } from "@/core/models/match-log";
import { decideWinner } from "@/core/services/match-lifecycle";
import { getScoringEngine, replayScore } from "@/core/services/scoring";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { requireArenaAccess } from "@/server/live";
import { activeParticipants, notifyMany } from "@/server/notify";
import { compact, docToJson, toDates } from "@/server/serialize";

/**
 * POST /api/volunteer/matches/[id]/action — every way a match changes while
 * it is being played: start, pause, resume, score, undo, finish, cancel.
 *
 * One route rather than seven, because every one of these needs the exact
 * same arena check and the exact same "read the match, decide, write the
 * match" transaction — splitting them would mean keeping that in sync in
 * seven places. `requireArenaAccess` is the whole reason this cannot be a
 * client write: a volunteer's rule is "your arena, and nothing else",
 * which a Firestore security rule cannot evaluate against a `Shift`
 * document the way a server route can.
 */
const bodySchema = z.object({
  action: z.enum(["start", "pause", "resume", "finish", "score", "undo", "cancel"]),
  scoreAction: scoreActionSchema.optional(),
  winner: matchSideSchema.optional(),
});

const winningTeam = (match: Pick<Match, "homeTeam" | "awayTeam">, side: MatchSide) => (side === "home" ? match.homeTeam : match.awayTeam);

export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "match:score");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing match id.");
  const { action, scoreAction, winner: explicitWinner } = await readBody(request, bodySchema);

  const db = adminDb();
  const matchRef = db.collection(COLLECTIONS.matches).doc(id);
  const preSnap = await matchRef.get();
  if (!preSnap.exists) throw ApiError.notFound("That match no longer exists.");
  const pre = toDates(preSnap.data()) as unknown as Match;

  await requireArenaAccess(caller, pre.festId, pre.arenaId);

  // The actor's display name, read once and reused for both the timeline
  // entry and the audit log — the same lookup `audit()` would otherwise do
  // a second time on every single score tap.
  const actorSnap = await db.collection(COLLECTIONS.users).doc(caller.uid).get();
  const actorName = String(actorSnap.data()?.name ?? actorSnap.data()?.fullName ?? caller.email);

  let becameComplete = false;
  let finalWinner: MatchSide | undefined;

  await db.runTransaction(async (tx) => {
    const matchSnap = await tx.get(matchRef);
    if (!matchSnap.exists) throw ApiError.notFound("That match no longer exists.");
    const match = toDates(matchSnap.data()) as unknown as Match;

    // Firestore transactions require every read before any write, so a
    // knockout advancement's read of the next match happens up front — the
    // actual write to it is issued alongside everything else, at the end of
    // whichever branch needs it.
    const readNextMatch = async (): Promise<FirebaseFirestore.DocumentReference | null> => {
      if (!match.nextMatchId) return null;
      const nextRef = db.collection(COLLECTIONS.matches).doc(match.nextMatchId);
      const nextSnap = await tx.get(nextRef);
      return nextSnap.exists ? nextRef : null;
    };
    const writeAdvancement = (nextRef: FirebaseFirestore.DocumentReference | null, side: MatchSide) => {
      if (!nextRef) return;
      const field = match.nextMatchSlot === "away" ? "awayTeam" : "homeTeam";
      tx.update(nextRef, { [field]: winningTeam(match, side), updatedAt: FieldValue.serverTimestamp() });
    };

    if (action === "start") {
      if (match.status !== "upcoming") throw ApiError.unprocessable("This match has already started.");
      tx.update(matchRef, { status: "live", paused: false, startedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return;
    }

    if (action === "pause" || action === "resume") {
      if (match.status !== "live") throw ApiError.unprocessable("This match is not live.");
      tx.update(matchRef, { paused: action === "pause", updatedAt: FieldValue.serverTimestamp() });
      return;
    }

    if (action === "cancel") {
      if (match.status === "completed") throw ApiError.unprocessable("A finished match cannot be cancelled.");
      tx.update(matchRef, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
      return;
    }

    if (action === "score") {
      if (match.status === "completed" || match.status === "cancelled") throw ApiError.unprocessable("This match is not live.");
      if (!scoreAction) throw ApiError.badRequest("scoreAction is required.");

      const engine = getScoringEngine(match.sportType);
      // A match created before engines seeded their own state has an empty `detail`; give it the sport's defaults.
      const current = Object.keys(match.score.detail ?? {}).length === 0 ? { ...match.score, detail: engine.initialState(match.matchConfig).detail } : match.score;
      const { state, label } = engine.applyAction(current, scoreAction, match.matchConfig);

      const winSide = state.isComplete ? decideWinner(state) : null;
      const nextRef = winSide ? await readNextMatch() : null;

      const logRef = db.collection(COLLECTIONS.matchLog).doc();
      tx.set(
        logRef,
        compact({
          id: logRef.id,
          matchId: id,
          festId: match.festId,
          eventId: match.eventId,
          type: scoreAction.type,
          side: scoreAction.side,
          payload: scoreAction.payload,
          label,
          undone: false,
          at: FieldValue.serverTimestamp(),
          createdBy: caller.uid,
          createdByName: actorName,
        }),
      );

      const updates: Record<string, unknown> = { score: state, updatedAt: FieldValue.serverTimestamp() };
      if (match.status === "upcoming") {
        updates.status = "live";
        updates.startedAt = FieldValue.serverTimestamp();
      }

      if (winSide) {
        updates.status = "completed";
        updates.winner = winSide;
        updates.finishedAt = FieldValue.serverTimestamp();
        becameComplete = true;
        finalWinner = winSide;
        writeAdvancement(nextRef, winSide);
      }

      tx.update(matchRef, compact(updates));
      return;
    }

    if (action === "finish") {
      if (match.status === "completed") throw ApiError.unprocessable("This match has already finished.");
      if (match.status === "cancelled") throw ApiError.unprocessable("A cancelled match cannot be finished.");
      const side = decideWinner(match.score, explicitWinner);
      if (!side) throw ApiError.badRequest("Scores are tied — pick a winner explicitly.");
      const nextRef = await readNextMatch();

      tx.update(matchRef, { status: "completed", winner: side, finishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      becameComplete = true;
      finalWinner = side;
      writeAdvancement(nextRef, side);
      return;
    }

    if (action === "undo") {
      const logSnap = await tx.get(db.collection(COLLECTIONS.matchLog).where("matchId", "==", id));
      const entries = logSnap.docs.map((doc) => toDates({ ...doc.data(), id: doc.id }) as unknown as MatchLogEntry);
      const active = activeLog(entries);
      const last = active.at(-1);
      if (!last) throw ApiError.unprocessable("Nothing to undo.");

      const lastDoc = logSnap.docs.find((doc) => doc.id === last.id)!;
      tx.update(lastDoc.ref, { undone: true });

      const remaining = active.slice(0, -1);
      const score = replayScore(match.sportType, match.matchConfig, remaining);
      tx.update(matchRef, { score, updatedAt: FieldValue.serverTimestamp() });
      return;
    }
  });

  const auditAction =
    action === "start" ? "match_started"
    : action === "score" ? "match_score_updated"
    : action === "undo" ? "match_score_undone"
    : action === "finish" ? "match_finished"
    : action === "cancel" ? "match_cancelled"
    : "match_updated";

  await audit({ ...caller, name: actorName }, {
    action: auditAction,
    summary: `Match ${action}`,
    festId: pre.festId,
    eventId: pre.eventId,
    subjectType: "match",
    subjectId: id,
  });

  if (action === "start") {
    const participants = await activeParticipants({ eventId: pre.eventId });
    await notifyMany(
      participants.map((p) => ({
        userId: p.userId,
        type: "match_starting" as const,
        title: "Match starting",
        body: `${p.eventTitle} is starting now.`,
        link: `/live/${pre.eventId}`,
        festId: pre.festId,
        eventId: pre.eventId,
      })),
    );
    if (isFinalMatch(pre)) {
      await notifyMany(
        participants.map((p) => ({
          userId: p.userId,
          type: "tournament_final_started" as const,
          title: "Final started",
          body: `The final of ${p.eventTitle} is under way.`,
          link: `/live/${pre.eventId}`,
          festId: pre.festId,
          eventId: pre.eventId,
        })),
      );
    }
  }

  if (becameComplete && isFinalMatch(pre) && finalWinner) {
    const finalSnap = await matchRef.get();
    const finalMatch = toDates(finalSnap.data()) as unknown as Match;
    const champion = matchWinnerName(finalMatch) ?? "The champion";
    const participants = await activeParticipants({ eventId: pre.eventId });
    await notifyMany(
      participants.map((p) => ({
        userId: p.userId,
        type: "champion_declared" as const,
        title: "Champion declared",
        body: `${champion} won ${p.eventTitle}.`,
        link: `/live/${pre.eventId}`,
        festId: pre.festId,
        eventId: pre.eventId,
      })),
    );
  }

  const finalSnap = await matchRef.get();
  return ok({ match: docToJson(finalSnap) });
});
