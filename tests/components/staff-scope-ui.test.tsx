import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasAtLeast, homeForRole } from "@/core/permissions";
import type { Session } from "@/core/services/auth-service";

/**
 * What the browser shows an account, and where it sends it.
 *
 * A volunteer that was given no fest and no event role lands in the Student section, sees no staff link, and is turned away
 * from the staff area. An admin is never lowered: the accounts migrated from the original organizers kept an empty scope and
 * keep the role they were given (what an admin may touch is decided per fest, see tests/emulator/staff-scope-access.test.ts,
 * which the server applies on every request), so the screen and the API cannot disagree.
 */

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  auth: { value: null as unknown },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
  usePathname: () => "/admin",
}));
vi.mock("@/components/providers", () => ({ useAuth: () => h.auth.value }));
vi.mock("@/data/firebase/client", () => ({ firebaseAuth: () => ({}) }));
vi.mock("@/data/api-client", () => ({ api: vi.fn() }));

import { toSession } from "@/data/firebase/auth-service";
import { RequireRole } from "@/components/shell/require-role";
import { postAuthDestination } from "@/components/auth/destination";

const sessionFor = async (claims: Record<string, unknown>): Promise<Session> =>
  toSession({ uid: "u1", email: "person@example.test", emailVerified: true, displayName: "Person", getIdTokenResult: async () => ({ claims }) } as never);

const signedIn = (session: Session) => {
  h.auth.value = { status: "signed-in", ready: true, session, profile: { profileCompleted: true } };
};

beforeEach(() => h.replace.mockReset());
afterEach(cleanup);

describe("the session the browser builds from the token", () => {
  it.each([
    ["admin with no fest and no event role (never lowered)", { role: "admin", festIds: [] }, "admin"],
    ["admin whose claims carry no scope at all (never lowered)", { role: "admin" }, "admin"],
    ["volunteer with no fest and no event role", { role: "volunteer", festIds: [] }, "student"],
    ["a role nobody defined", { role: "owner", festIds: ["f1"] }, "student"],
    ["no role at all", {}, "student"],
    ["a student", { role: "student", festIds: [] }, "student"],
    ["admin assigned a fest (legacy scope)", { role: "admin", festIds: ["f1"] }, "admin"],
    ["admin by event role", { role: "admin", festIds: [], fm: ["f1"], br: "admin" }, "admin"],
    ["admin whose event roles are looked up (too many for a token)", { role: "admin", festIds: [], fx: true }, "admin"],
    ["volunteer assigned a fest", { role: "volunteer", festIds: ["f1"] }, "volunteer"],
    ["the old name for a volunteer, assigned", { role: "organizer", festIds: ["f1"] }, "volunteer"],
    ["the platform's super admin (its own scope)", { role: "super_admin", festIds: [] }, "super_admin"],
  ])("%s -> %s", async (_name, claims, expected) => {
    expect((await sessionFor(claims)).role).toBe(expected);
  });

  it("sends an unassigned volunteer to the Student section and offers it no staff link", async () => {
    const session = await sessionFor({ role: "volunteer", festIds: [] });
    expect(postAuthDestination(session, { profileCompleted: true })).toBe("/explore");
    expect(homeForRole(session.role)).toBe("/explore");
    // The expression the account menu and the profile page use to decide whether to show "Admin side".
    expect(hasAtLeast(session.role, "volunteer")).toBe(false);
  });

  it("leaves an admin with an empty scope exactly where it was: the Admin Panel", async () => {
    const session = await sessionFor({ role: "admin", festIds: [] });
    expect(postAuthDestination(session, { profileCompleted: true })).toBe("/admin");
    expect(homeForRole(session.role)).toBe("/admin");
    expect(hasAtLeast(session.role, "volunteer")).toBe(true);
  });

  it("sends an assigned admin to the Admin Panel", async () => {
    const session = await sessionFor({ role: "admin", festIds: ["f1"] });
    expect(postAuthDestination(session, { profileCompleted: true })).toBe("/admin");
    expect(hasAtLeast(session.role, "volunteer")).toBe(true);
  });
});

describe("opening /admin directly", () => {
  it("turns an unassigned volunteer away from the staff area and never renders it", async () => {
    signedIn(await sessionFor({ role: "volunteer", festIds: [] }));
    render(
      <RequireRole minimum="volunteer" fallback="/explore">
        <div>STAFF CONTENT</div>
      </RequireRole>,
    );
    expect(screen.queryByText("STAFF CONTENT")).toBeNull();
    expect(h.replace).toHaveBeenCalledWith("/explore");
  });

  it("lets an admin with an empty scope open the Admin Panel, as it always could", async () => {
    signedIn(await sessionFor({ role: "admin", festIds: [] }));
    render(
      <RequireRole minimum="admin" fallback="/explore">
        <div>ADMIN PANEL CONTENT</div>
      </RequireRole>,
    );
    expect(screen.getByText("ADMIN PANEL CONTENT")).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("turns a student away the same way", async () => {
    signedIn(await sessionFor({ role: "student", festIds: [] }));
    render(
      <RequireRole minimum="admin" fallback="/explore">
        <div>ADMIN PANEL CONTENT</div>
      </RequireRole>,
    );
    expect(screen.queryByText("ADMIN PANEL CONTENT")).toBeNull();
    expect(h.replace).toHaveBeenCalledWith("/explore");
  });

  it("shows an explicit 'no access' page when no fallback is given", async () => {
    signedIn(await sessionFor({ role: "student", festIds: [] }));
    render(
      <RequireRole minimum="admin">
        <div>ADMIN PANEL CONTENT</div>
      </RequireRole>,
    );
    expect(screen.queryByText("ADMIN PANEL CONTENT")).toBeNull();
    expect(screen.getByText(/don.t have access/i)).toBeTruthy();
  });

  it("lets an explicitly assigned admin in", async () => {
    signedIn(await sessionFor({ role: "admin", festIds: ["f1"] }));
    render(
      <RequireRole minimum="admin" fallback="/explore">
        <div>ADMIN PANEL CONTENT</div>
      </RequireRole>,
    );
    expect(screen.getByText("ADMIN PANEL CONTENT")).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("lets an Event Super Admin (event role, ordinary account otherwise) in", async () => {
    signedIn(await sessionFor({ role: "admin", festIds: [], fm: ["novax"], br: "student" }));
    render(
      <RequireRole minimum="admin" fallback="/explore">
        <div>ADMIN PANEL CONTENT</div>
      </RequireRole>,
    );
    expect(screen.getByText("ADMIN PANEL CONTENT")).toBeTruthy();
  });

  it("never lets an event role open the platform area", async () => {
    signedIn(await sessionFor({ role: "admin", festIds: [], fm: ["novax"], br: "admin" }));
    render(
      <RequireRole minimum="super_admin" fallback="/admin">
        <div>PLATFORM CONTENT</div>
      </RequireRole>,
    );
    expect(screen.queryByText("PLATFORM CONTENT")).toBeNull();
    expect(h.replace).toHaveBeenCalledWith("/admin");
  });
});
