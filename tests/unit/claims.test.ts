import { describe, expect, it } from "vitest";
import { CLAIMS_BUDGET_BYTES, CLAIMS_LIMIT_BYTES, ClaimsTooLargeError, MAX_INLINE_MEMBERSHIPS, buildClaims, memberClaimsInSync } from "@/core/claims";

const id = (n: number) => `F${String(n).padStart(19, "0")}`; // a 20-character id, like a Firestore auto id
const ids = (count: number, from = 0) => Array.from({ length: count }, (_, i) => id(from + i));
const bytes = (claims: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(claims)).length;

describe("what goes in the token", () => {
  it("is just the role and the legacy scope for an account with no event role", () => {
    const built = buildClaims({ role: "student", festIds: [], memberFestIds: [] });
    expect(built).toMatchObject({ claims: { role: "student", festIds: [] }, lookup: false });
    expect(built.claims).not.toHaveProperty("br");
    expect(built.claims).not.toHaveProperty("fm");
    expect(built.claims).not.toHaveProperty("fx");
  });

  it("lists the fests an account holds an event role on, raises the role for the app, and keeps the base role for the rules", () => {
    const built = buildClaims({ role: "student", festIds: [], memberFestIds: ["f1", "f2"], ceiling: "admin" });
    expect(built.claims).toEqual({ role: "admin", br: "student", festIds: [], fm: ["f1", "f2"] });
    expect(built.lookup).toBe(false);
  });

  it("never lowers an account's own role, and never reaches the platform's", () => {
    expect(buildClaims({ role: "admin", festIds: ["a"], memberFestIds: ["f1"], ceiling: "volunteer" }).claims).toMatchObject({ role: "admin", br: "admin" });
    for (const ceiling of ["volunteer", "admin"] as const) {
      expect(buildClaims({ role: "student", festIds: [], memberFestIds: ["f1"], ceiling }).claims.role).not.toBe("super_admin");
    }
    expect(buildClaims({ role: "super_admin", festIds: [], memberFestIds: [] }).claims.role).toBe("super_admin");
  });

  it("carries the temporary-password flag", () => {
    expect(buildClaims({ role: "student", festIds: [], memberFestIds: [], mustChangePassword: true }).claims.mustChangePassword).toBe(true);
  });

  it("does not list the same fest twice", () => {
    expect(buildClaims({ role: "student", festIds: [], memberFestIds: ["f1", "f1"], ceiling: "admin" }).claims.fm).toEqual(["f1"]);
  });
});

describe("an account with many event roles", () => {
  it("lists up to the inline limit", () => {
    const built = buildClaims({ role: "student", festIds: [], memberFestIds: ids(MAX_INLINE_MEMBERSHIPS), ceiling: "admin" });
    expect(built.lookup).toBe(false);
    expect(built.claims.fm).toHaveLength(MAX_INLINE_MEMBERSHIPS);
    expect(built.bytes).toBeLessThanOrEqual(CLAIMS_BUDGET_BYTES);
  });

  it("switches to lookup mode past it: no list in the token, a flag telling the rules to look the membership up", () => {
    const built = buildClaims({ role: "student", festIds: [], memberFestIds: ids(MAX_INLINE_MEMBERSHIPS + 1), ceiling: "admin" });
    expect(built.lookup).toBe(true);
    expect(built.claims).toMatchObject({ role: "admin", br: "student", fx: true });
    expect(built.claims).not.toHaveProperty("fm");
  });

  it("stays well inside Firebase's limit however many roles there are, which is the point", () => {
    for (const count of [9, 40, 400]) {
      const built = buildClaims({ role: "student", festIds: [], memberFestIds: ids(count), ceiling: "admin" });
      expect(built.lookup).toBe(true);
      expect(bytes(built.claims), `${count} roles`).toBeLessThan(CLAIMS_LIMIT_BYTES);
    }
  });

  it("goes to lookup mode early when the legacy scope leaves too little room to list them", () => {
    const built = buildClaims({ role: "admin", festIds: ids(33), memberFestIds: ids(6, 100), ceiling: "admin" });
    expect(built.lookup).toBe(true);
    expect(bytes(built.claims)).toBeLessThanOrEqual(CLAIMS_BUDGET_BYTES);
  });
});

describe("what cannot be shrunk is refused, never truncated", () => {
  it("refuses a legacy scope that does not fit on its own", () => {
    expect(() => buildClaims({ role: "admin", festIds: ids(60), memberFestIds: [] })).toThrow(ClaimsTooLargeError);
    expect(() => buildClaims({ role: "admin", festIds: ids(60), memberFestIds: ["f1"], ceiling: "admin" })).toThrow(ClaimsTooLargeError);
  });

  it("still accepts one that fits", () => {
    expect(() => buildClaims({ role: "admin", festIds: ids(30), memberFestIds: [] })).not.toThrow();
  });
});

describe("noticing a token that has fallen behind", () => {
  const expected = (members: string[]) => buildClaims({ role: "student", festIds: [], memberFestIds: members, ceiling: "admin" }).claims;

  it("is in step when the token lists the same fests, in any order", () => {
    expect(memberClaimsInSync({ fm: ["f2", "f1"], br: "student" }, expected(["f1", "f2"]))).toBe(true);
  });

  it("notices a role granted since the token was minted", () => {
    expect(memberClaimsInSync({}, expected(["f1"]))).toBe(false);
    expect(memberClaimsInSync({ fm: ["f1"], br: "student" }, expected(["f1", "f2"]))).toBe(false);
  });

  it("notices a role revoked since the token was minted", () => {
    expect(memberClaimsInSync({ fm: ["f1", "f2"], br: "student" }, expected(["f1"]))).toBe(false);
    expect(memberClaimsInSync({ fm: ["f1"], br: "student" }, buildClaims({ role: "student", festIds: [], memberFestIds: [] }).claims)).toBe(false);
  });

  it("is in step for an account with no event role and a token with none", () => {
    expect(memberClaimsInSync({}, buildClaims({ role: "student", festIds: [], memberFestIds: [] }).claims)).toBe(true);
  });

  it("compares lookup mode by its flag, not by a list", () => {
    const many = expected(ids(12));
    expect(memberClaimsInSync({ fx: true, br: "student" }, many)).toBe(true);
    expect(memberClaimsInSync({ fm: ids(12), br: "student" }, many)).toBe(false);
  });
});
