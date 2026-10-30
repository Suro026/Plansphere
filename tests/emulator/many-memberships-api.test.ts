import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLAIMS_LIMIT_BYTES, MAX_INLINE_MEMBERSHIPS } from "@/core/claims";
import { membershipIdFor } from "@/core/models/membership";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { applyClaims } from "@/server/credentials";
import { ApiError } from "@/server/errors";
import { syncMemberAccess } from "@/server/membership";
import { GET as listMembers, POST as assignMember } from "@/app/api/admin/fests/[id]/members/route";
import { DELETE as revokeMember } from "@/app/api/admin/fests/[id]/members/[uid]/route";
import { GET as roster } from "@/app/api/volunteer/roster/route";
import { GET as myAccess } from "@/app/api/me/access/route";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * An account that holds event roles on many main events (a college's tech fest, cultural fest, sports meet, ...).
 *
 * Firebase caps a token's custom claims at 1,000 bytes, so past a handful of events the claims cannot list them. They carry a
 * pointer instead and the rules / API read the membership documents. What these pin down: the token stays small however many
 * roles there are; the authority is exactly what the memberships grant, no more and no less; a token that has fallen behind a
 * grant or a revocation is repaired; and what cannot be shrunk is refused rather than silently truncated.
 */

const festId = (n: number) => `fest-${String(n).padStart(3, "0")}-${"x".repeat(11)}`; // 20 characters, like a Firestore id
const claimsOf = async (user: TestUser) => (await adminAuth().getUser(user.uid)).customClaims ?? {};
const bytes = (claims: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(claims)).length;

const writeMembership = (user: TestUser, id: string, role = "head", status = "active") =>
  adminDb()
    .collection(COLLECTIONS.festMembers)
    .doc(membershipIdFor(id, user.uid))
    .set({ id: membershipIdFor(id, user.uid), festId: id, userId: user.uid, role, eventIds: [], duties: [], status, createdBy: "seed", createdAt: new Date(), updatedAt: new Date() });

/** Seeds `count` fests the account heads, and writes their memberships - without touching the account's claims. */
const headOf = async (user: TestUser, count: number) => {
  const ids = Array.from({ length: count }, (_, i) => festId(i));
  for (const id of ids) {
    await seedFest({ id, slug: id, ownerId: user.uid });
    await writeMembership(user, id);
  }
  return ids;
};

const members = (user: TestUser, id: string, token = user.idToken) => callRoute(listMembers, { path: `/api/admin/fests/${id}/members`, params: { id }, token });

beforeAll(async () => {
  await resetAuth();
});

beforeEach(async () => {
  await resetFirestore();
});

describe("claims for an account with several event roles", () => {
  it("lists the fests in the token while there are few of them", async () => {
    const user = await mintUser();
    await headOf(user, 3);
    await syncMemberAccess(user.uid);

    const claims = await claimsOf(user);
    expect(claims.fm).toHaveLength(3);
    expect(claims).not.toHaveProperty("fx");
    expect(claims).toMatchObject({ role: "admin", br: "student" });
  });

  it("switches at the inline limit: at it the list is carried, one past it the token points instead", async () => {
    const user = await mintUser();
    const ids = await headOf(user, MAX_INLINE_MEMBERSHIPS);
    await syncMemberAccess(user.uid);
    expect((await claimsOf(user)).fm).toHaveLength(MAX_INLINE_MEMBERSHIPS);

    await seedFest({ id: festId(99), slug: "one-more", ownerId: user.uid });
    await writeMembership(user, festId(99));
    await syncMemberAccess(user.uid);
    const claims = await claimsOf(user);
    expect(claims.fx).toBe(true);
    expect(claims).not.toHaveProperty("fm");
    expect(ids).toHaveLength(MAX_INLINE_MEMBERSHIPS);
  });

  it("stays far inside Firebase's limit however many events the account has, and keeps its base role", async () => {
    const user = await mintUser();
    await headOf(user, 60);
    await syncMemberAccess(user.uid);

    const claims = await claimsOf(user);
    expect(bytes(claims)).toBeLessThan(CLAIMS_LIMIT_BYTES / 2);
    expect(claims).toMatchObject({ fx: true, br: "student", role: "admin" });
    expect(claims.role).not.toBe("super_admin");
    // The profile mirror lists them all - it is not bound by the token's limit - so the app can still show every fest.
    const profile = (await adminDb().collection(COLLECTIONS.users).doc(user.uid).get()).data()!;
    expect(profile.memberOf).toHaveLength(60);
    expect(profile).toMatchObject({ role: "student", festIds: [] });
  });
});

describe("authority does not depend on the list being in the token", () => {
  it("honours every role through the API from a pointer-only token, and only those", async () => {
    const user = await mintUser();
    const ids = await headOf(user, 14);
    await seedFest({ id: "not-theirs", slug: "not-theirs", ownerId: "someone-else" });
    await syncMemberAccess(user.uid);
    const token = await freshToken(user);

    expect(await claimsOf(user)).toMatchObject({ fx: true });
    for (const id of [ids[0]!, ids[13]!]) expect((await members(user, id, token)).status, id).toBe(200);
    expect((await members(user, "not-theirs", token)).status).toBe(403);
  });

  it("takes a revoked role away on the very next request, even though the token still points at it", async () => {
    const user = await mintUser();
    const ids = await headOf(user, 10);
    await syncMemberAccess(user.uid);
    const token = await freshToken(user);
    expect((await members(user, ids[3]!, token)).status).toBe(200);

    await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor(ids[3]!, user.uid)).set({ status: "revoked", updatedAt: new Date() }, { merge: true });
    expect((await members(user, ids[3]!, token)).status).toBe(403);
    expect((await members(user, ids[4]!, token)).status).toBe(200); // the others are untouched
  });
});

describe("a token that has fallen behind the memberships is repaired", () => {
  it("rewrites the claims and tells the client to sign in fresh after a grant the claims missed", async () => {
    const user = await mintUser();
    const [id] = await headOf(user, 1); // the membership and the profile mirror exist; the claims write never happened
    await adminDb().collection(COLLECTIONS.users).doc(user.uid).set({ memberOf: [id] }, { merge: true });
    expect(await claimsOf(user)).not.toHaveProperty("fm");

    const stale = await callRoute(myAccess, { path: "/api/me/access", token: user.idToken });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ refreshToken: true, memberships: [{ festId: id, role: "head" }] });
    expect((await claimsOf(user)).fm).toEqual([id]);

    // With a token minted after the repair there is nothing left to repair, and no loop.
    const fresh = await callRoute(myAccess, { path: "/api/me/access", token: await freshToken(user) });
    expect(fresh.body.refreshToken).toBe(false);
  });

  it("drops a revoked role from the claims the same way", async () => {
    const user = await mintUser();
    const [id] = await headOf(user, 1);
    await syncMemberAccess(user.uid);
    const token = await freshToken(user);
    expect((await claimsOf(user)).fm).toEqual([id]);

    await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor(id!, user.uid)).set({ status: "revoked", updatedAt: new Date() }, { merge: true });
    const res = await callRoute(myAccess, { path: "/api/me/access", token });
    expect(res.body).toMatchObject({ refreshToken: true, memberships: [] });
    expect(await claimsOf(user)).not.toHaveProperty("fm");
  });

  it("does not touch the claims of an account that is already in step", async () => {
    const user = await mintUser();
    await headOf(user, 2);
    await syncMemberAccess(user.uid);
    const before = await claimsOf(user);
    const res = await callRoute(myAccess, { path: "/api/me/access", token: await freshToken(user) });
    expect(res.body.refreshToken).toBe(false);
    expect(await claimsOf(user)).toEqual(before);
  });
});

describe("what cannot be shrunk is refused, not truncated", () => {
  it("refuses a legacy fest-wide scope too large for a token, and leaves the account's claims as they were", async () => {
    const user = await mintUser({ role: "admin", festIds: ["fest1"] });
    const before = await claimsOf(user);
    const tooMany = Array.from({ length: 60 }, (_, i) => festId(i));

    const error = await applyClaims(user.uid, { role: "admin", festIds: tooMany }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect(await claimsOf(user)).toEqual(before);
  });
});

describe("a claims write that fails after a committed grant or revocation", () => {
  // A legacy fest list too long for any token: the membership commits, but the claims can never be rewritten for this account.
  const tooMany = Array.from({ length: 60 }, (_, i) => festId(500 + i));

  const setup = async () => {
    const head = await mintUser({ name: "Head Of One" });
    await seedFest({ id: "fest-x", slug: "fest-x", ownerId: head.uid });
    await seedEvent({ id: "ev-x", festId: "fest-x", slug: "ev-x" });
    await writeMembership(head, "fest-x");
    await syncMemberAccess(head.uid);
    const target = await mintUser({ role: "volunteer", festIds: ["fest-other"], name: "Heavy Scope Volunteer" });
    await adminDb().collection(COLLECTIONS.users).doc(target.uid).set({ festIds: tooMany }, { merge: true });
    return { head, headToken: await freshToken(head), target };
  };

  const assign = (head: TestUser, token: string, email: string) =>
    callRoute(assignMember, { method: "POST", path: "/api/admin/fests/fest-x/members", params: { id: "fest-x" }, token, body: { email, role: "volunteer", eventIds: ["ev-x"], duties: ["entry"] } });

  it("still grants, reports the claims as pending, writes the audit entry, and the person works at once through the API", async () => {
    const { head, headToken, target } = await setup();
    const res = await assign(head, headToken, target.email);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId: target.uid, role: "volunteer", claimsSync: "pending" });

    // The membership and the mirror the API uses to find it were committed together.
    expect((await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor("fest-x", target.uid)).get()).data()).toMatchObject({ status: "active", role: "volunteer" });
    expect((await adminDb().collection(COLLECTIONS.users).doc(target.uid).get()).data()?.memberOf).toEqual(["fest-x"]);

    // The audit trail has the grant, and says the claims are pending.
    const entries = (await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "member_assigned").get()).docs.map((d) => d.data());
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toMatchObject({ claimsSync: "pending" });

    // In force already: the API reads the membership, not the token.
    const token = await freshToken(target);
    expect((await callRoute(roster, { path: "/api/volunteer/roster?eventId=ev-x", token })).status).toBe(200);
    // And the person's own access screen says what is wrong rather than hiding it.
    const access = await callRoute(myAccess, { path: "/api/me/access", token });
    expect(access.body).toMatchObject({ claimsError: true, memberships: [{ festId: "fest-x", role: "volunteer" }] });
  });

  it("still revokes, immediately, and does not let a stale token keep the role", async () => {
    const { head, headToken, target } = await setup();
    expect((await assign(head, headToken, target.email)).status).toBe(201);
    const token = await freshToken(target);
    expect((await callRoute(roster, { path: "/api/volunteer/roster?eventId=ev-x", token })).status).toBe(200);

    const res = await callRoute(revokeMember, { method: "DELETE", path: "/x", params: { id: "fest-x", uid: target.uid }, token: headToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "revoked", claimsSync: "pending" });
    expect((await callRoute(roster, { path: "/api/volunteer/roster?eventId=ev-x", token })).status).toBe(403);
    const entries = (await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "member_revoked").get()).docs;
    expect(entries).toHaveLength(1);
  });

  it("says nothing about the claims when they were written", async () => {
    const { head, headToken } = await setup();
    const ordinary = await mintUser({ name: "Ordinary Volunteer" });
    const res = await assign(head, headToken, ordinary.email);
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("claimsSync");
    expect((await claimsOf(ordinary)).fm).toEqual(["fest-x"]);
  });
});
