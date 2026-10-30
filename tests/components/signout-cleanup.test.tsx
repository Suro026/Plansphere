import * as React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/core/services/auth-service";

/**
 * Signing out must not leave the last person's registrations, teammates and ticket codes in the browser for the next
 * person on a shared computer, and must never touch anyone else's data or get in the way of signing in or out.
 */

const h = vi.hoisted(() => {
  type Listener = (session: unknown) => void;
  const listeners = new Set<Listener>();
  return {
    listeners,
    emit: (session: unknown) => listeners.forEach((listener) => listener(session)),
    clearScannerCache: vi.fn(async () => true),
    auth: {
      onSessionChange: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      signOut: vi.fn(async () => undefined),
      refreshSession: vi.fn(async () => null),
    },
  };
});

vi.mock("@/data/firebase/auth-service", () => ({ authService: h.auth }));
vi.mock("@/data/repositories", () => ({ repositories: () => ({ users: { getById: vi.fn(async () => null) } }) }));
vi.mock("@/lib/offline/db", () => ({ clearScannerCache: h.clearScannerCache }));

import { Providers, useAuth } from "@/components/providers";

const session = (uid: string): Session => ({ uid, email: `${uid}@x.test`, emailVerified: true, displayName: uid, role: "student", festIds: [], mustChangePassword: false });

let signOutFromUi: () => Promise<void>;
let queryClient: ReturnType<typeof useQueryClient>;

const Probe = () => {
  signOutFromUi = useAuth().signOut;
  queryClient = useQueryClient();
  return null;
};

const mount = async () => {
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  await vi.waitFor(() => expect(h.listeners.size).toBe(1));
};

const CACHE = "plansphere.entries.v1";
const entriesOf = (uid: string) => window.localStorage.getItem(`${CACHE}.${uid}`);

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(`${CACHE}.alice`, JSON.stringify([{ ticket: "PS-ALICE00001" }]));
  window.localStorage.setItem(`${CACHE}.bob`, JSON.stringify([{ ticket: "PS-BOB0000001" }]));
  window.localStorage.setItem("plansphere.consent.v1", "rejected");
  h.listeners.clear();
  h.clearScannerCache.mockClear();
  h.auth.signOut.mockClear();
});

afterEach(() => {
  // Vitest globals are off, so Testing Library does not unmount between tests by itself.
  cleanup();
  vi.restoreAllMocks();
});

describe("signing out", () => {
  it("removes the signed-out account's cached entries and nobody else's, and empties the in-memory cache", async () => {
    await mount();
    act(() => h.emit(session("alice")));
    queryClient.setQueryData(["my-entries", "alice"], [{ ticket: "PS-ALICE00001" }]);

    act(() => h.emit(null));

    expect(entriesOf("alice")).toBeNull();
    expect(entriesOf("bob")).not.toBeNull(); // another person's copy on the same browser is untouched
    expect(window.localStorage.getItem("plansphere.consent.v1")).toBe("rejected"); // unrelated storage is untouched
    expect(queryClient.getQueryData(["my-entries", "alice"])).toBeUndefined();
  });

  it("does not clear anything when the page first loads signed out, or when the same account's session refreshes", async () => {
    await mount();
    act(() => h.emit(null)); // first state after load
    expect(entriesOf("alice")).not.toBeNull();
    expect(entriesOf("bob")).not.toBeNull();

    act(() => h.emit(session("alice")));
    act(() => h.emit(session("alice"))); // token refresh, claims change
    expect(entriesOf("alice")).not.toBeNull();
  });

  it("signing in does not remove the signing-in account's own cache (it is what opens the pass offline)", async () => {
    await mount();
    act(() => h.emit(null));
    act(() => h.emit(session("bob")));
    expect(entriesOf("bob")).not.toBeNull();
    expect(entriesOf("alice")).not.toBeNull();
  });

  it("clears the previous account when a different one replaces it without a null in between", async () => {
    await mount();
    act(() => h.emit(session("alice")));
    act(() => h.emit(session("bob")));
    expect(entriesOf("alice")).toBeNull();
    expect(entriesOf("bob")).not.toBeNull();
  });

  it("still signs out when storage refuses the removal", async () => {
    await mount();
    act(() => h.emit(session("alice")));
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(() => act(() => h.emit(null))).not.toThrow();
  });

  it("an explicit sign-out also asks for the scanner's offline cache to be emptied, after the sign-out itself", async () => {
    await mount();
    act(() => h.emit(session("alice")));
    await act(async () => {
      await signOutFromUi();
    });
    expect(h.auth.signOut).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.clearScannerCache).toHaveBeenCalledTimes(1));
  });

  it("a failure to clear the scanner cache never breaks signing out", async () => {
    h.clearScannerCache.mockRejectedValueOnce(new Error("indexeddb unavailable"));
    await mount();
    await act(async () => {
      await expect(signOutFromUi()).resolves.toBeUndefined();
    });
  });
});
