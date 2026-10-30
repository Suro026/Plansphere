import type { AuditAction } from "@/core/models/audit";
import type { Caller } from "./api";
import { COLLECTIONS, FieldValue, adminDb } from "./firebase-admin";
import { compact } from "./serialize";

/**
 * Writes one audit entry. Called from route handlers after a privileged
 * write succeeds. Never throws — an audit failure must not undo the action
 * it records — but it does log, because a silent gap in the trail is worse
 * than a noisy one.
 */
export const audit = async (
  caller: Caller & { name?: string },
  entry: {
    action: AuditAction;
    summary: string;
    festId?: string;
    eventId?: string;
    subjectType?: "registration" | "event" | "fest" | "user" | "result" | "certificate" | "shift" | "match" | "arena";
    subjectId?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> => {
  try {
    const db = adminDb();

    // The caller's display name is not on the token; read it once so the log
    // says "Priya (fest admin)" rather than a uid.
    let actorName = caller.name;
    if (!actorName) {
      const snap = await db.collection(COLLECTIONS.users).doc(caller.uid).get();
      actorName = String(snap.data()?.name ?? snap.data()?.fullName ?? caller.email);
    }

    await db.collection(COLLECTIONS.auditLog).add(
      compact({
        ...entry,
        summary: entry.summary.slice(0, 200),
        actorId: caller.uid,
        actorName,
        actorRole: caller.role,
        createdAt: FieldValue.serverTimestamp(),
      }),
    );
  } catch (error) {
    console.error("[audit] failed to record", entry.action, error);
  }
};
