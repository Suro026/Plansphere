import { describe, expect, it } from "vitest";
import { eventHeadSchema, festMayBePublished, festVerificationState } from "@/core/models/fest";
import { can } from "@/core/permissions";

describe("festVerificationState", () => {
  it("reports the review state, and calls an event that predates the review step legacy, never approved", () => {
    expect(festVerificationState({ verification: { status: "pending" } })).toBe("pending");
    expect(festVerificationState({ verification: { status: "approved" } })).toBe("approved");
    expect(festVerificationState({ verification: { status: "rejected" } })).toBe("rejected");
    expect(festVerificationState({})).toBe("legacy");
    expect(festVerificationState({ verification: undefined })).toBe("legacy");
  });
});

describe("festMayBePublished", () => {
  it("blocks an event under review or turned down, and nothing else", () => {
    expect(festMayBePublished({ verification: { status: "pending" } })).toBe(false);
    expect(festMayBePublished({ verification: { status: "rejected" } })).toBe(false);
    expect(festMayBePublished({ verification: { status: "approved" } })).toBe(true);
    expect(festMayBePublished({})).toBe(true);
  });
});

describe("who may verify", () => {
  it("is the platform's super admin alone", () => {
    expect(can("super_admin", "fest:verify")).toBe(true);
    for (const role of ["admin", "volunteer", "student"] as const) expect(can(role, "fest:verify"), role).toBe(false);
    expect(can(undefined, "fest:verify")).toBe(false);
  });
});

describe("the identity document reference", () => {
  const head = { name: "Meena", designation: "Secretary", phone: "+919000000000" };

  it("accepts the path the upload route hands back", () => {
    const path = "users/uid_123-ABC/identity/0b9f2c4e-1d6a-4c1e-9d55-6a7a3f2f8e10.pdf";
    expect(eventHeadSchema.safeParse({ ...head, idDocumentPath: path }).success).toBe(true);
    expect(eventHeadSchema.safeParse(head).success).toBe(true);
  });

  it("refuses anything that is not an uploaded identity document: a URL, another folder, a traversal, another type", () => {
    for (const bad of [
      "https://example.com/id.png",
      "users/uid/avatars/abc.png",
      "users/uid/identity/../../secrets/x.png",
      "users/uid/identity/abc.exe",
      "fests/f1/identity/abc.png",
      "/users/uid/identity/abc.png",
      "users//identity/abc.png",
    ]) {
      expect(eventHeadSchema.safeParse({ ...head, idDocumentPath: bad }).success, bad).toBe(false);
    }
  });
});
