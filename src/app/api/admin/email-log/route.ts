import { z } from "zod";
import { ApiError, handler, ok, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { EMAIL_TEMPLATES, emailService } from "@/server/email";
import { docToJson } from "@/server/serialize";

const querySchema = z.object({
  festId: z.string().min(1),
  template: z.enum(EMAIL_TEMPLATES).optional(),
  status: z.enum(["sent", "failed", "skipped"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/admin/email-log?festId=…[&template=…][&status=…][&limit=…]
 *
 * The delivery log for one fest, newest first, with the counts per status
 * for the same window. Equality filters only (no composite index): the
 * newest N are sorted in memory.
 */
export const GET = handler(async (request) => {
  const caller = await requirePermission(request, "audit:read");
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw ApiError.badRequest("Bad query.", parsed.error.flatten());
  const q = parsed.data;
  requireFestAccess(caller, q.festId);

  let ref: FirebaseFirestore.Query = adminDb().collection(COLLECTIONS.emailLog).where("festId", "==", q.festId);
  if (q.template) ref = ref.where("template", "==", q.template);
  if (q.status) ref = ref.where("status", "==", q.status);

  const snap = await ref.limit(1000).get();
  const rows = snap.docs
    .map((d) => docToJson<Record<string, unknown>>(d)!)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));

  const counts = { sent: 0, failed: 0, skipped: 0 };
  for (const r of rows) if (r.status === "sent" || r.status === "failed" || r.status === "skipped") counts[r.status] += 1;

  const mailer = emailService();
  return ok({ provider: { name: mailer.name, canSend: mailer.canSend }, counts, entries: rows.slice(0, q.limit) });
});
