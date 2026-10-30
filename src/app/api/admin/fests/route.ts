import { reachableFestIds } from "@/core/access";
import { createFestSchema } from "@/core/models/fest";
import { defaultRegistrationFields } from "@/core/models/registration-fields";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";
import { audit } from "@/server/audit";

/**
 * The fest container — the platform-staff path. Also created at
 * `POST /api/register-event`, the public self-service path any signed-in
 * account may use; that route sets the same fields (slug, `ownerId`, an
 * audit entry) for a caller who isn't a super admin.
 *
 * A fest is the parent of everything: events hang off it, staff are scoped to
 * it, certificates carry its name. Creating one used to be a client write
 * that the rules allowed a super admin to make directly; it runs here instead
 * so that the slug is checked for collisions in one place, the owner is
 * recorded, and the creation lands in the audit trail like every other
 * privileged act.
 */

/** POST /api/admin/fests — create a fest. Super admin only. */
export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "fest:create");
  const input = await readBody(request, createFestSchema);

  const db = adminDb();

  // The slug is the fest's public address, printed on posters. A duplicate
  // would make one of the two unreachable, so it is refused rather than
  // silently suffixed.
  const clash = await db.collection(COLLECTIONS.fests).where("slug", "==", input.slug).limit(1).get();
  if (!clash.empty) throw ApiError.conflict(`The address "${input.slug}" is already taken by another fest.`);

  const ref = db.collection(COLLECTIONS.fests).doc();

  await ref.set(
    compact({
      ...input,
      id: ref.id,
      status: "draft",
      stats: { events: 0, registrations: 0, checkIns: 0 },
      // Every fest starts asking the default set; the super admin tunes it
      // from Registration fields before opening.
      registrationFields: defaultRegistrationFields(),
      createdBy: caller.uid,
      ownerId: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );

  await audit(caller, {
    action: "fest_created",
    summary: `Created "${input.name}" (${input.slug})`,
    festId: ref.id,
    subjectType: "fest",
    subjectId: ref.id,
    details: { slug: input.slug, festType: input.festType, academicYear: input.academicYear ?? null },
  });

  const created = await ref.get();
  return ok({ fest: docToJson(created) }, 201);
}, { rateLimit: RATE_LIMITS.authenticated.staff });

/**
 * GET /api/admin/fests — every fest on the platform, with the counts the
 * super admin's list needs. Scoped admins get only theirs.
 */
export const GET = handler(async (request) => {
  const caller = await requirePermission(request, "registration:read");
  const db = adminDb();

  const snapshot = await db.collection(COLLECTIONS.fests).get();
  // Every fest the account can reach: its legacy scope plus the fests it holds a membership on.
  const reachable = new Set(reachableFestIds(caller));

  const fests = snapshot.docs
    .filter((doc) => caller.role === "super_admin" || reachable.has(doc.id))
    .map((doc) => docToJson<Record<string, unknown>>(doc))
    .filter((fest): fest is Record<string, unknown> => fest !== null)
    .sort((a, b) => String(b.startDate ?? "").localeCompare(String(a.startDate ?? "")));

  return ok({ fests });
});
