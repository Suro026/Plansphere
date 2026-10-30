import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { membershipIdFor } from "@/core/models/membership";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { syncMemberAccess } from "@/server/membership";
import { GET as platformStats } from "@/app/api/admin/platform/route";
import { GET as reviewQueue } from "@/app/api/admin/verifications/route";
import { GET as health } from "@/app/api/health/route";
import { GET as myAccess } from "@/app/api/me/access/route";
import { POST as createStaff } from "@/app/api/admin/staff/route";
import { DELETE as deleteStaff, PATCH as patchStaff } from "@/app/api/admin/staff/[id]/route";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, seedFest, type TestUser } from "./harness";

/**
 * The platform boundary through the real handlers and the real script, against the emulators.
 *
 * What these pin down: until the switch is thrown nothing changes; once it is, a super admin who is not on the registry (or
 * is suspended, or lacks a required second factor) is an ordinary account to every route; an event organizer is never lifted
 * onto the platform by the registry or by anything else; the app cannot mint a platform account; and the script is the only
 * way to change who is on the registry - and refuses to lock the platform out.
 */

let platformAdmin: TestUser;
let secondPlatformAdmin: TestUser;
let eventAdmin: TestUser;
let eventHead: TestUser;
let volunteer: TestUser;

const profile = (u: TestUser, role: string, festIds: string[] = [], extra: Record<string, unknown> = {}) =>
  adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role, festIds, disabled: false, profileCompleted: true, mustChangePassword: false, createdAt: new Date(), updatedAt: new Date(), ...extra });
const setBoundary = (data: Record<string, unknown>) => adminDb().collection(COLLECTIONS.platformConfig).doc("boundary").set(data);
const register = (u: TestUser, status = "active") => adminDb().collection(COLLECTIONS.platformStaff).doc(u.uid).set({ uid: u.uid, email: u.email, status });
const registryOf = async (u: TestUser) => (await adminDb().collection(COLLECTIONS.platformStaff).doc(u.uid).get()).data();
const boundaryDoc = async () => (await adminDb().collection(COLLECTIONS.platformConfig).doc("boundary").get()).data();

const stats = (u: TestUser, token = u.idToken) => callRoute(platformStats, { path: "/api/admin/platform", token });
const queue = (u: TestUser, token = u.idToken) => callRoute(reviewQueue, { path: "/api/admin/verifications", token });

beforeAll(async () => {
  await resetAuth();
  platformAdmin = await mintUser({ role: "super_admin", name: "Platform One" });
  secondPlatformAdmin = await mintUser({ role: "super_admin", name: "Platform Two" });
  eventAdmin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest Admin" });
  eventHead = await mintUser({ name: "Event Head" });
  volunteer = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Gate Volunteer" });
});

beforeEach(async () => {
  await resetFirestore();
  await seedFest({ ownerId: eventHead.uid });
  await profile(platformAdmin, "super_admin");
  await profile(secondPlatformAdmin, "super_admin");
  await profile(eventAdmin, "admin", ["fest1"]);
  await profile(eventHead, "student");
  await profile(volunteer, "volunteer", ["fest1"]);
  const id = membershipIdFor("fest1", eventHead.uid);
  await adminDb().collection(COLLECTIONS.festMembers).doc(id).set({ id, festId: "fest1", userId: eventHead.uid, role: "head", eventIds: [], duties: [], status: "active", createdBy: "seed", createdAt: new Date(), updatedAt: new Date() });
  await syncMemberAccess(eventHead.uid);
});

describe("before the boundary is enforced", () => {
  it("a super admin works exactly as it always has, registered or not", async () => {
    expect((await stats(platformAdmin)).status).toBe(200);
    expect((await queue(platformAdmin)).status).toBe(200);
  });

  it("also with the switch present but off", async () => {
    await setBoundary({ enforce: false, requireMfa: true });
    expect((await stats(platformAdmin)).status).toBe(200);
  });
});

describe("once enforced", () => {
  beforeEach(() => setBoundary({ enforce: true, requireMfa: false }));

  it("turns away a super admin who is not on the registry, and says why", async () => {
    const res = await stats(platformAdmin);
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/Platform access is not enabled/);
    expect((await queue(platformAdmin)).status).toBe(403);
  });

  it("lets a registered, active one through with the very same token", async () => {
    await register(platformAdmin);
    expect((await stats(platformAdmin)).status).toBe(200);
    expect((await queue(platformAdmin)).status).toBe(200);
  });

  it("takes effect on the next request in both directions - no new sign-in needed", async () => {
    await register(platformAdmin);
    expect((await stats(platformAdmin)).status).toBe(200);
    await register(platformAdmin, "suspended");
    const suspended = await stats(platformAdmin);
    expect(suspended.status).toBe(403);
    expect(String(suspended.body.error)).toMatch(/suspended/);
    await register(platformAdmin, "active");
    expect((await stats(platformAdmin)).status).toBe(200);
    await register(platformAdmin, "removed");
    expect((await stats(platformAdmin)).status).toBe(403);
  });

  it("knows who is registered: one platform account being on the registry does nothing for another", async () => {
    await register(platformAdmin);
    expect((await stats(secondPlatformAdmin)).status).toBe(403);
  });

  it("treats the turned-away account as an ordinary one everywhere, including the health detail only the platform sees", async () => {
    const detail = await callRoute(health, { path: "/api/health", token: platformAdmin.idToken });
    expect(detail.body.detail).toBe("redacted");
    await register(platformAdmin);
    const full = await callRoute(health, { path: "/api/health", token: platformAdmin.idToken });
    expect(full.body.detail).toBe("full");
  });

  it("does not repair the claims of a turned-away account, and reports why", async () => {
    const res = await callRoute(myAccess, { path: "/api/me/access", token: platformAdmin.idToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: "student", platformDenied: "not-registered", refreshToken: false });
    expect(res.body.claimsError).toBeUndefined();
  });

  it("requires a second factor when the switch says so, and the emulator's password sign-ins have none", async () => {
    await setBoundary({ enforce: true, requireMfa: true });
    await register(platformAdmin);
    const res = await stats(platformAdmin);
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/second factor/);
  });
});

describe("an event organizer is never the platform", () => {
  it.each([["before the boundary is enforced", false], ["once it is", true]] as const)("%s", async (_name, enforced) => {
    if (enforced) await setBoundary({ enforce: true, requireMfa: false });
    // Even listed on the registry, and even holding a membership, none of them is a super admin.
    for (const u of [eventAdmin, eventHead, volunteer]) await register(u);
    const headToken = await freshToken(eventHead);
    expect((await stats(eventAdmin)).status).toBe(403);
    expect((await stats(eventHead, headToken)).status).toBe(403);
    expect((await stats(volunteer)).status).toBe(403);
    expect((await queue(eventAdmin)).status).toBe(403);
    expect((await queue(eventHead, headToken)).status).toBe(403);
  });
});

describe("the app cannot mint a platform account once the boundary is enforced", () => {
  let seq = 0;
  const invite = (over: Record<string, unknown> = {}) => {
    seq += 1;
    return { name: "New Platform", email: `new-platform-${seq}@plansphere.test`, role: "super_admin", festIds: [], ...over };
  };

  it("still creates one before enforcement, as it always did", async () => {
    const res = await callRoute(createStaff, { path: "/api/admin/staff", token: platformAdmin.idToken, body: invite() });
    expect(res.status).toBe(201);
  });

  it("refuses to create one afterwards - the account would carry the role and none of the power", async () => {
    await setBoundary({ enforce: true, requireMfa: false });
    await register(platformAdmin);
    const res = await callRoute(createStaff, { path: "/api/admin/staff", token: platformAdmin.idToken, body: invite() });
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/platform-staff/);
    // ...and still creates ordinary staff.
    expect((await callRoute(createStaff, { path: "/api/admin/staff", token: platformAdmin.idToken, body: invite({ role: "volunteer", festIds: ["fest1"] }) })).status).toBe(201);
  });

  it("refuses to promote an existing account afterwards", async () => {
    await setBoundary({ enforce: true, requireMfa: false });
    await register(platformAdmin);
    const res = await callRoute(patchStaff, { method: "PATCH", path: `/api/admin/staff/${volunteer.uid}`, params: { id: volunteer.uid }, token: platformAdmin.idToken, body: { role: "super_admin" } });
    expect(res.status).toBe(422);
    expect((await adminDb().collection(COLLECTIONS.users).doc(volunteer.uid).get()).data()?.role).toBe("volunteer");
  });

  it("an event organizer cannot create or promote anyone onto the platform, enforced or not", async () => {
    for (const enforced of [false, true]) {
      if (enforced) await setBoundary({ enforce: true, requireMfa: false });
      const created = await callRoute(createStaff, { path: "/api/admin/staff", token: eventAdmin.idToken, body: invite() });
      expect(created.status).toBe(403);
      const promoted = await callRoute(patchStaff, { method: "PATCH", path: `/api/admin/staff/${volunteer.uid}`, params: { id: volunteer.uid }, token: eventAdmin.idToken, body: { role: "super_admin" } });
      expect(promoted.status).toBe(403);
    }
  });
});

describe("leaving the platform team leaves the registry", () => {
  // Demoting or deleting revokes the account's tokens and changes its claims, so each case uses an account of its own.
  const leaver = async () => {
    const u = await mintUser({ role: "super_admin", name: "Leaving Platform Member" });
    await profile(u, "super_admin");
    await register(u);
    await register(platformAdmin);
    return u;
  };

  it("demoting a platform account removes its registry entry, so a later change of role cannot bring the power back", async () => {
    const target = await leaver();
    const res = await callRoute(patchStaff, { method: "PATCH", path: `/api/admin/staff/${target.uid}`, params: { id: target.uid }, token: platformAdmin.idToken, body: { role: "admin", festIds: ["fest1"] } });
    expect(res.status).toBe(200);
    expect(await registryOf(target)).toMatchObject({ status: "removed" });
    expect(await registryOf(platformAdmin)).toMatchObject({ status: "active" });
  });

  it("deleting one does too", async () => {
    const target = await leaver();
    const res = await callRoute(deleteStaff, { method: "DELETE", path: `/api/admin/staff/${target.uid}`, params: { id: target.uid }, token: platformAdmin.idToken });
    expect(res.status).toBe(200);
    expect(await registryOf(target)).toMatchObject({ status: "removed" });
  });

  it("disabling one leaves its entry alone: the disabled account is already shut out, and re-enabling should not need the script", async () => {
    const target = await leaver();
    const res = await callRoute(patchStaff, { method: "PATCH", path: `/api/admin/staff/${target.uid}`, params: { id: target.uid }, token: platformAdmin.idToken, body: { disabled: true } });
    expect(res.status).toBe(200);
    expect(await registryOf(target)).toMatchObject({ status: "active" });
  });
});

/* ───────────── the script ───────────── */

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const account = Buffer.from(JSON.stringify({ project_id: "plansphere-test", client_email: "p@plansphere-test.iam.gserviceaccount.com", private_key: privateKey })).toString("base64");
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["scripts/platform-staff.mjs", ...args], { env: { ...process.env, FIREBASE_SERVICE_ACCOUNT: account }, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const audits = async (action: string) => (await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", action).get()).docs.map((d) => d.data());

describe("npm run platform-staff", () => {
  it("writes nothing without --apply", async () => {
    expect(run("bootstrap").status).toBe(0);
    expect(run("add", platformAdmin.email).status).toBe(0);
    expect((await adminDb().collection(COLLECTIONS.platformStaff).get()).size).toBe(0);
    // The safety checks run on a dry run too: with nobody registered it already says it would refuse.
    expect(run("enforce", "on").status).toBe(1);
    await register(platformAdmin);
    expect(run("enforce", "on").status).toBe(0);
    expect(run("remove", platformAdmin.email).status).toBe(0);
    expect((await adminDb().collection(COLLECTIONS.platformStaff).get()).size).toBe(1);
    expect(await registryOf(platformAdmin)).toMatchObject({ status: "active" });
    expect(await boundaryDoc()).toBeUndefined();
    expect((await adminDb().collection(COLLECTIONS.auditLog).get()).size).toBe(0);
  });

  it("bootstrap registers every enabled super admin, and no one else", async () => {
    await profile(secondPlatformAdmin, "super_admin", [], { disabled: true });
    const r = run("bootstrap", "--apply");
    expect(r.status).toBe(0);
    expect(await registryOf(platformAdmin)).toMatchObject({ status: "active", addedBy: "script" });
    expect(await registryOf(secondPlatformAdmin)).toBeUndefined(); // disabled
    for (const u of [eventAdmin, eventHead, volunteer]) expect(await registryOf(u)).toBeUndefined();
    expect((await audits("platform_staff_changed")).length).toBe(1);
  });

  it("add registers an existing super admin and refuses anyone who is not one - it never grants a role", async () => {
    expect(run("add", platformAdmin.email, "--apply").status).toBe(0);
    expect(await registryOf(platformAdmin)).toMatchObject({ status: "active" });
    for (const u of [eventAdmin, eventHead, volunteer]) {
      const r = run("add", u.email, "--apply");
      expect(r.status, u.email).toBe(1);
      expect(r.out).toMatch(/not a super admin/);
      expect(await registryOf(u)).toBeUndefined();
    }
    const unknown = run("add", "nobody-here@plansphere.test", "--apply");
    expect(unknown.status).toBe(1);
  });

  it("will not enforce with nobody registered - that would lock the platform out", async () => {
    const r = run("enforce", "on", "--apply");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/nobody would have platform access/);
    expect(await boundaryDoc()).toBeUndefined();
  });

  it("enforces once someone is registered, and records it", async () => {
    run("add", platformAdmin.email, "--apply");
    expect(run("enforce", "on", "--apply").status).toBe(0);
    expect(await boundaryDoc()).toMatchObject({ enforce: true, requireMfa: false });
    expect((await audits("platform_boundary_changed")).length).toBe(1);
    expect((await stats(platformAdmin)).status).toBe(200);
    expect((await stats(secondPlatformAdmin)).status).toBe(403); // never registered
  });

  it("will not require a second factor nobody has enrolled", async () => {
    run("add", platformAdmin.email, "--apply");
    const r = run("enforce", "on", "--require-mfa", "--apply");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not enrolled/);
    expect(await boundaryDoc()).toBeUndefined();
  });

  it("will not remove or suspend the last usable platform account while enforced", async () => {
    run("add", platformAdmin.email, "--apply");
    run("enforce", "on", "--apply");
    for (const command of ["remove", "suspend"]) {
      const r = run(command, platformAdmin.email, "--apply");
      expect(r.status, command).toBe(1);
      expect(r.out).toMatch(/last usable platform account/);
    }
    expect(await registryOf(platformAdmin)).toMatchObject({ status: "active" });
    // With a second account registered it is allowed.
    run("add", secondPlatformAdmin.email, "--apply");
    expect(run("suspend", platformAdmin.email, "--apply").status).toBe(0);
    expect(await registryOf(platformAdmin)).toMatchObject({ status: "suspended" });
    expect((await stats(platformAdmin)).status).toBe(403);
    expect(run("reinstate", platformAdmin.email, "--apply").status).toBe(0);
    expect((await stats(platformAdmin)).status).toBe(200);
  });

  it("can always switch the boundary off - the way back from a lockout", async () => {
    run("add", platformAdmin.email, "--apply");
    run("enforce", "on", "--apply");
    await register(platformAdmin, "removed"); // as if the registry were wrong
    expect((await stats(platformAdmin)).status).toBe(403);
    expect(run("enforce", "off", "--apply").status).toBe(0);
    expect(await boundaryDoc()).toMatchObject({ enforce: false });
    expect((await stats(platformAdmin)).status).toBe(200);
  });

  it("lists the registry and warns about super admins that are not on it", async () => {
    run("add", platformAdmin.email, "--apply");
    const r = run("list");
    expect(r.status).toBe(0);
    expect(r.out).toContain(platformAdmin.email);
    expect(r.out).toMatch(/NOT on the registry: 1/);
  });
});
