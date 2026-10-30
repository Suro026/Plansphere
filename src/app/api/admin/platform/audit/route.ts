import { z } from "zod";
import { AUDIT_ACTIONS, auditEntrySchema, type AuditEntry } from "@/core/models/audit";
import { ApiError, handler, ok, requirePermission } from "@/server/api";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { toJson } from "@/server/serialize";

/**
 * GET /api/admin/platform/audit — the platform-wide audit browser.
 *
 * `auditLog`'s own rules already let a super admin `list` the whole
 * collection (their `managesFest` check is unconditionally true), which is
 * what makes a cross-fest browser possible at all — every other staff role
 * is confined to the fests on their token. Only one of `festId`/`userId`/
 * `action` may be given at a time: each is backed by its own two-field
 * composite index (`firestore.indexes.json`), and combining them would need
 * an index per combination for a screen that is a debugging aid, not a
 * high-traffic path.
 */
const querySchema = z.object({
  festId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const GET = handler(async (request) => {
  await requirePermission(request, "platform:manage");
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw ApiError.badRequest("Bad audit query.");
  const { festId, userId, action, from, to, cursor, limit } = parsed.data;

  if ([festId, userId, action].filter(Boolean).length > 1) {
    throw ApiError.badRequest("Filter by fest, user or action type — not more than one at a time.");
  }

  const db = adminDb();
  let query = db.collection(COLLECTIONS.auditLog) as FirebaseFirestore.Query;
  if (festId) query = query.where("festId", "==", festId);
  if (userId) query = query.where("actorId", "==", userId);
  if (action) query = query.where("action", "==", action);
  if (from) query = query.where("createdAt", ">=", from);
  if (to) query = query.where("createdAt", "<=", to);
  query = query.orderBy("createdAt", "desc");
  if (cursor) query = query.startAfter(cursor);
  query = query.limit(limit);

  const snap = await query.get();
  const entries: AuditEntry[] = snap.docs
    .map((doc) => auditEntrySchema.safeParse(toJson({ ...doc.data(), id: doc.id })))
    .filter((r): r is { success: true; data: AuditEntry } => r.success)
    .map((r) => r.data);

  const last = entries.at(-1);
  return ok({
    entries,
    nextCursor: entries.length === limit && last ? last.createdAt.toISOString() : null,
  });
});
