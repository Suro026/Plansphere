import * as Sentry from "@sentry/nextjs";
import type { CreateNotification } from "@/core/models/notification";
import { COLLECTIONS, FieldValue, adminDb } from "./firebase-admin";
import { compact } from "./serialize";

/**
 * The one place the server writes `notifications`.
 *
 * Every producer — registration, team changes, waitlist, results,
 * certificates, reminders, announcements — calls these two functions, so the
 * document shape and the "never fail the caller" contract live here once.
 * A notification that cannot be written is logged and dropped: the seat was
 * still granted, the certificate still issued.
 */

export const notify = async (input: CreateNotification): Promise<string | null> => {
  try {
    const ref = await adminDb()
      .collection(COLLECTIONS.notifications)
      .add(
        compact({
          ...input,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }),
      );
    return ref.id;
  } catch (error) {
    console.warn("[notify] dropped notification:", error instanceof Error ? error.message : error);
    Sentry.captureException(error, { tags: { kind: "notify" }, level: "warning", extra: { userId: input.userId, type: input.type } });
    return null;
  }
};

/**
 * Fan-out in batches under Firestore's 500-write limit. Recipients are
 * de-duplicated by user id so a leader who is also on a second team gets one
 * copy per notification, not one per membership.
 */
export const notifyMany = async (inputs: CreateNotification[]): Promise<number> => {
  const seen = new Set<string>();
  const unique = inputs.filter((n) => {
    const key = `${n.userId}|${n.type}|${n.eventId ?? ""}|${n.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return 0;

  const db = adminDb();
  let written = 0;
  try {
    for (let i = 0; i < unique.length; i += 450) {
      const batch = db.batch();
      for (const input of unique.slice(i, i + 450)) {
        batch.set(
          db.collection(COLLECTIONS.notifications).doc(),
          compact({ ...input, read: false, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }),
        );
      }
      await batch.commit();
      written += Math.min(450, unique.length - i);
    }
  } catch (error) {
    console.warn("[notify] fan-out stopped early:", error instanceof Error ? error.message : error);
    Sentry.captureException(error, { tags: { kind: "notify-fanout" }, level: "warning", extra: { written, total: unique.length } });
  }
  return written;
};

/**
 * Everyone holding an active entry for an event (or a whole fest): the
 * account that registered plus every teammate who has an account. Returns
 * user ids with the email and name to address them by, de-duplicated.
 */
export const activeParticipants = async (scope: { eventId: string } | { festId: string }): Promise<Array<{ userId: string; email: string; name: string; registrationId: string; eventId: string; eventTitle: string }>> => {
  const db = adminDb();
  const field = "eventId" in scope ? "eventId" : "festId";
  const value = "eventId" in scope ? scope.eventId : scope.festId;
  // Draft teams are registered people who have not finished assembling; an
  // announcement about the event is as much theirs as anyone's.
  const snap = await db.collection(COLLECTIONS.registrations).where(field, "==", value).where("status", "in", ["draft", "confirmed"]).get();

  const out = new Map<string, { userId: string; email: string; name: string; registrationId: string; eventId: string; eventTitle: string }>();
  for (const doc of snap.docs) {
    const r = doc.data();
    const members = Array.isArray(r.members) ? (r.members as Array<{ userId?: string; email?: string; name?: string; inviteStatus?: string }>) : [];
    for (const m of members) {
      if (!m.userId || !m.email || m.inviteStatus === "declined") continue;
      if (!out.has(m.userId)) {
        out.set(m.userId, { userId: m.userId, email: m.email, name: m.name ?? "", registrationId: doc.id, eventId: String(r.eventId), eventTitle: String(r.eventTitle ?? "") });
      }
    }
    if (r.userId && !out.has(String(r.userId))) {
      out.set(String(r.userId), { userId: String(r.userId), email: String(r.userEmail), name: String(r.userName ?? ""), registrationId: doc.id, eventId: String(r.eventId), eventTitle: String(r.eventTitle ?? "") });
    }
  }
  return [...out.values()];
};
