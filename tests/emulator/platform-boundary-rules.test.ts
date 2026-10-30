import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

/**
 * The platform boundary in firestore.rules (`platformOk()`): the same table as tests/unit/platform-boundary.test.ts.
 *
 * "Platform power" is probed three ways, because the rules reach it three ways: a platform-only list (the audit log), a
 * platform read of someone else's draft fest, and a platform write (renaming a fest it has no membership on).
 */

let env: RulesTestEnvironment;
const [host = "127.0.0.1", port = "8080"] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");

const token = (uid: string, role: string, extra: Record<string, unknown> = {}) => ({ uid, email: `${uid}@plansphere.test`, email_verified: true, role, festIds: [] as string[], ...extra });
const platform = token("sup1", "super_admin");
const otherPlatform = token("sup2", "super_admin");
const organizer = token("org1", "admin", { festIds: ["fest1"] });
const as = (claims: { uid: string } & Record<string, unknown>) => {
  const { uid, ...rest } = claims;
  return env.authenticatedContext(uid, rest).firestore();
};

const platformReads = (db: ReturnType<typeof as>) => getDocs(collection(db, "auditLog"));
const draftRead = (db: ReturnType<typeof as>) => getDoc(doc(db, "fests", "drafty"));
const platformWrite = (db: ReturnType<typeof as>) => updateDoc(doc(db, "fests", "drafty"), { name: "Renamed", updatedAt: new Date() });

const allowed = async (who: { uid: string } & Record<string, unknown>) => {
  await assertSucceeds(platformReads(as(who)));
  await assertSucceeds(draftRead(as(who)));
  await assertSucceeds(platformWrite(as(who)));
};
const denied = async (who: { uid: string } & Record<string, unknown>) => {
  await assertFails(platformReads(as(who)));
  await assertFails(draftRead(as(who)));
  await assertFails(platformWrite(as(who)));
};

const boundary = (data: Record<string, unknown>) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "platformConfig", "boundary"), data));
const registry = (uid: string, status: string) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "platformStaff", uid), { uid, status }));

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? "plansphere-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
  });
});
afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = new Date();
    await setDoc(doc(db, "fests", "drafty"), { id: "drafty", slug: "drafty", name: "Drafty", status: "draft", organizationName: "T", startDate: "2026-10-01", endDate: "2026-10-02", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "fests", "fest1"), { id: "fest1", slug: "f1", name: "Fest One", status: "published", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "auditLog", "a1"), { action: "event_updated", actorId: "x", festId: "fest1", summary: "x", createdAt: now });
  });
});

describe("before the boundary is enforced, nothing changes", () => {
  it("lets a super admin through with no boundary document at all", async () => {
    await allowed(platform);
  });

  it("and with a boundary document that is switched off, registered or not", async () => {
    await boundary({ enforce: false, requireMfa: true });
    await allowed(platform);
    await registry("sup1", "removed");
    await allowed(platform);
  });

  it("reads only an explicit true as enforcement", async () => {
    await boundary({ enforce: "true" });
    await allowed(platform);
    await boundary({});
    await allowed(platform);
  });
});

describe("once enforced, a super admin is the platform only while it is on the registry", () => {
  beforeEach(() => boundary({ enforce: true, requireMfa: false }));

  it("turns an unregistered super admin into an ordinary account, for every rule at once", async () => {
    await denied(platform);
  });

  it("lets a registered, active one through", async () => {
    await registry("sup1", "active");
    await allowed(platform);
  });

  it("refuses a suspended or removed one, and any status nobody defined", async () => {
    for (const status of ["suspended", "removed", "admin", ""]) {
      await registry("sup1", status);
      await denied(platform);
    }
  });

  it("knows who is registered: sup1 being on the registry does nothing for sup2", async () => {
    await registry("sup1", "active");
    await allowed(platform);
    await denied(otherPlatform);
  });
});

describe("a second factor, when the boundary requires one", () => {
  beforeEach(async () => {
    await boundary({ enforce: true, requireMfa: true });
    await registry("sup1", "active");
  });

  it("refuses a registered super admin who signed in with a password alone", async () => {
    await denied(platform);
    await denied({ ...platform, firebase: { sign_in_provider: "password" } });
  });

  it("lets it through when the sign-in used a second factor", async () => {
    await allowed({ ...platform, firebase: { sign_in_provider: "password", sign_in_second_factor: "totp" } });
  });

  it("does not let a second factor stand in for being registered", async () => {
    await denied({ ...otherPlatform, firebase: { sign_in_provider: "password", sign_in_second_factor: "totp" } });
  });
});

describe("the registry never lends the platform to anyone who is not already a super admin", () => {
  beforeEach(async () => {
    await boundary({ enforce: true, requireMfa: false });
    await registry("org1", "active");
    await registry("head1", "active");
  });

  it("gives an event organizer nothing by listing them", async () => {
    await assertFails(platformReads(as(organizer)));
    await assertFails(draftRead(as(organizer)));
    await assertFails(platformWrite(as(organizer)));
  });

  it("gives an Event Head by membership nothing either", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "festMembers", "fest1__head1"), { id: "fest1__head1", festId: "fest1", userId: "head1", role: "head", eventIds: [], duties: [], status: "active", createdBy: "x", createdAt: new Date(), updatedAt: new Date() }),
    );
    const head = token("head1", "admin", { br: "student", fm: ["fest1"] });
    await assertFails(platformReads(as(head)));
    await assertFails(draftRead(as(head))); // a draft of another fest
    await assertSucceeds(updateDoc(doc(as(head), "fests", "fest1"), { name: "Renamed By Head", updatedAt: new Date() })); // their own fest, as before
  });

  it("leaves the ordinary staff of a fest exactly as they were while the boundary is enforced", async () => {
    await assertSucceeds(updateDoc(doc(as(organizer), "fests", "fest1"), { name: "Renamed By Admin", updatedAt: new Date() }));
  });
});

describe("only the service account writes the registry or the switch", () => {
  it("denies every client read and write of both, whoever is asking", async () => {
    await boundary({ enforce: true, requireMfa: false });
    await registry("sup1", "active");
    for (const who of [platform, organizer, token("stu1", "student")]) {
      const db = as(who);
      await assertFails(getDoc(doc(db, "platformStaff", "sup1")));
      await assertFails(getDoc(doc(db, "platformConfig", "boundary")));
      await assertFails(getDocs(collection(db, "platformStaff")));
      await assertFails(setDoc(doc(db, "platformStaff", who.uid), { uid: who.uid, status: "active" }));
      await assertFails(setDoc(doc(db, "platformStaff", "sup1"), { uid: "sup1", status: "removed" }));
      await assertFails(setDoc(doc(db, "platformConfig", "boundary"), { enforce: false }));
      await assertFails(updateDoc(doc(db, "platformConfig", "boundary"), { enforce: false }));
    }
    const signedOut = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(signedOut, "platformStaff", "sup1")));
    await assertFails(setDoc(doc(signedOut, "platformConfig", "boundary"), { enforce: false }));
  });
});
