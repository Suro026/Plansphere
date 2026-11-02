// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/server/errors";
import { STORAGE_DISABLED_MESSAGE, STORAGE_UNAVAILABLE_MESSAGE, guardStorage, toStorageApiError } from "@/server/storage/guard";

/**
 * What a caller is told, and what the log says, when a storage call fails. Before the guard only a missing bucket got a
 * deliberate answer: a rejected key, a paused project, a timeout or an unconfigured deployment came out of the upload route
 * as an unrecognised error, which the API handler reports as a 500 - the request was fine, the dependency was not.
 */

afterEach(() => vi.restoreAllMocks());

const supabaseError = (message: string, status?: number) => Object.assign(new Error(message), { name: "StorageApiError", status, statusCode: status ? String(status) : undefined });
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

describe("what a storage failure becomes", () => {
  it.each([
    ["a rejected key", supabaseError("Invalid API key", 401)],
    ["a forbidden key", supabaseError("jwt malformed", 403)],
    ["an unreachable project", Object.assign(new Error("fetch failed"), { name: "StorageUnknownError" })],
    ["a request that timed out", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
    ["a Supabase server error", supabaseError("Internal Server Error", 500)],
    ["a paused project", supabaseError("Project is paused", 540)],
  ])("is a 503 storage-unavailable for %s", (_name, error) => {
    quiet();
    const result = toStorageApiError("upload", error, "event-assets");
    expect(result).toBeInstanceOf(ApiError);
    expect(result.status).toBe(503);
    expect(result.code).toBe("storage-unavailable");
    expect(result.message).toBe(STORAGE_UNAVAILABLE_MESSAGE);
  });

  it.each([
    ["a missing bucket", supabaseError("Bucket not found", 404)],
    ["storage that was never configured", Object.assign(new Error("Supabase Storage is not configured: SUPABASE_URL is empty. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"), { name: "StorageNotConfiguredError" })],
  ])("is a 503 storage-disabled, telling the user what to do instead, for %s", (_name, error) => {
    quiet();
    const result = toStorageApiError("upload", error, "uploads");
    expect(result.status).toBe(503);
    expect(result.code).toBe("storage-disabled");
    expect(result.message).toBe(STORAGE_DISABLED_MESSAGE);
  });

  it("keeps a size or type refusal from Supabase as the client's problem (413 / 415), not an outage", () => {
    quiet();
    expect(toStorageApiError("upload", supabaseError("The object exceeded the maximum allowed size", 413), "uploads")).toMatchObject({ status: 413, code: "too-large" });
    expect(toStorageApiError("upload", supabaseError("mime type text/html is not supported", 415), "uploads")).toMatchObject({ status: 415, code: "unsupported-type" });
  });

  it("passes an ApiError that is already deliberate straight through", () => {
    const own = new ApiError(415, "unsupported-type", "That file is not a PDF.");
    expect(toStorageApiError("upload", own)).toBe(own);
  });

  it("logs one fixed code and the bucket - never the message the client returned, which can carry a URL or a path", () => {
    const errors = quiet();
    toStorageApiError("upload", supabaseError("Invalid API key for https://abcdefghijklmnop.supabase.co/storage/v1/object/uploads/users/u1/identity/x.pdf", 401), "uploads");
    const logged = errors.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(logged).toContain("[storage] upload failed: unauthorized (uploads)");
    expect(logged).not.toContain("supabase.co");
    expect(logged).not.toContain("x.pdf");
  });

  it("never lets the Supabase message, the environment variable names or the project into what the client is told", () => {
    quiet();
    for (const error of [
      supabaseError("Invalid API key for https://abcdefghijklmnop.supabase.co", 401),
      Object.assign(new Error("Supabase Storage is not configured: SUPABASE_SERVICE_ROLE_KEY is empty."), { name: "StorageNotConfiguredError" }),
    ]) {
      const told = JSON.stringify(toStorageApiError("upload", error, "uploads"));
      expect(told).not.toMatch(/supabase|SERVICE_ROLE|abcdefghijklmnop|apikey/i);
    }
  });
});

describe("guardStorage", () => {
  it("returns what the call returns", async () => {
    await expect(guardStorage("sign", "uploads", async () => "https://signed")).resolves.toBe("https://signed");
  });

  it("rethrows any failure as the deliberate error", async () => {
    quiet();
    await expect(
      guardStorage("delete", "event-assets", async () => {
        throw supabaseError("Internal Server Error", 500);
      }),
    ).rejects.toMatchObject({ status: 503, code: "storage-unavailable" });
  });
});
