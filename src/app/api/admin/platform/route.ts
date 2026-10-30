import { handler, ok, requirePermission } from "@/server/api";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { toJson } from "@/server/serialize";

/**
 * GET /api/admin/platform — everything the super admin's dashboard draws.
 *
 * One route rather than six, because the dashboard is one screen and six
 * round trips on a cold serverless start is most of a second. Counts come
 * from `count()` aggregations, which bill one read each instead of one per
 * document — a platform with 40,000 registrations would otherwise make this
 * page the most expensive thing in the app.
 */
export const GET = handler(async (request) => {
  await requirePermission(request, "platform:manage");
  const db = adminDb();

  const today = new Date().toISOString().slice(0, 10);

  const count = async (collection: string, build?: (q: FirebaseFirestore.Query) => FirebaseFirestore.Query) => {
    const base = db.collection(collection);
    const query = build ? build(base) : base;
    const snapshot = await query.count().get();
    return snapshot.data().count;
  };

  // "Active" here means "profile document touched in the last 30 days" — an
  // approximation, but the honest one: the alternative, scanning every Auth
  // user's `lastSignInTime`, has no `count()` equivalent and would be the
  // single most expensive thing this dashboard does.
  const activeCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [fests, students, admins, volunteers, registrations, certificates, published, activeUsers30d] = await Promise.all([
    count(COLLECTIONS.fests),
    count(COLLECTIONS.users, (q) => q.where("role", "==", "student")),
    count(COLLECTIONS.users, (q) => q.where("role", "in", ["admin", "super_admin"])),
    count(COLLECTIONS.users, (q) => q.where("role", "in", ["volunteer", "organizer"])),
    count(COLLECTIONS.registrations, (q) => q.where("status", "==", "confirmed")),
    count(COLLECTIONS.certificates, (q) => q.where("revoked", "==", false)),
    count(COLLECTIONS.fests, (q) => q.where("status", "==", "published")),
    count(COLLECTIONS.users, (q) => q.where("updatedAt", ">=", activeCutoff)),
  ]);

  // The three tables. Deliberately short — a dashboard that lists fifty rows
  // is a report, and there is a page for each of those.
  const [festDocs, adminDocs, registrationDocs, eventCount] = await Promise.all([
    db.collection(COLLECTIONS.fests).orderBy("createdAt", "desc").limit(6).get(),
    db.collection(COLLECTIONS.users).where("role", "in", ["admin", "super_admin"]).orderBy("createdAt", "desc").limit(6).get(),
    db.collection(COLLECTIONS.registrations).orderBy("createdAt", "desc").limit(8).get(),
    count(COLLECTIONS.events),
  ]);

  const recentFests = festDocs.docs.map((doc) => {
    const data = toJson<Record<string, unknown>>({ ...doc.data(), id: doc.id });
    return {
      id: doc.id,
      name: String(data.name ?? ""),
      slug: String(data.slug ?? ""),
      status: String(data.status ?? "draft"),
      festType: String(data.festType ?? "other"),
      startDate: String(data.startDate ?? ""),
      endDate: String(data.endDate ?? ""),
      stats: (data.stats as Record<string, number> | undefined) ?? { events: 0, registrations: 0, checkIns: 0 },
    };
  });

  const recentAdmins = adminDocs.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      name: String(data.name ?? data.fullName ?? ""),
      email: String(data.email ?? ""),
      role: String(data.role ?? "admin"),
      festIds: Array.isArray(data.festIds) ? (data.festIds as string[]) : [],
      mustChangePassword: data.mustChangePassword === true,
      disabled: data.disabled === true,
      createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
    };
  });

  const recentRegistrations = registrationDocs.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      userName: String(data.userName ?? ""),
      userEmail: String(data.userEmail ?? ""),
      eventTitle: String(data.eventTitle ?? ""),
      festId: String(data.festId ?? ""),
      status: String(data.status ?? "confirmed"),
      seats: Number(data.seats ?? 1),
      createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
    };
  });

  // "Active" is the question a dashboard is actually asked: what is running
  // right now, not what exists. A single-field range keeps this on the
  // automatic index; the remaining two conditions are applied in memory,
  // which is free at any plausible number of fests.
  const runningSnap = await db.collection(COLLECTIONS.fests).where("endDate", ">=", today).get();
  const activeFests = runningSnap.docs.filter((doc) => {
    const data = doc.data();
    return data.status === "published" && String(data.startDate ?? "") <= today;
  }).length;

  return ok({
    kpis: {
      fests,
      publishedFests: published,
      activeFests,
      events: eventCount,
      students,
      admins,
      volunteers,
      registrations,
      certificates,
      activeUsers30d,
    },
    recentFests,
    recentAdmins,
    recentRegistrations,
  });
});
