// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `npm run verify:storage` is how an operator learns the exact storage failure without a Firebase credential or a Vercel login.
 * It must say so plainly when nothing is configured, exit non-zero whenever storage is not healthy, and never print the URL or key.
 */

const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["scripts/verify-storage.mjs"], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 30_000 });

describe("npm run verify:storage", () => {
  it("is wired to the script and reads .env.local only when it exists", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["verify:storage"]).toBe("node --env-file-if-exists=.env.local scripts/verify-storage.mjs");
  });

  it("says storage is not configured, and exits non-zero, when neither value is set", () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/not configured/i);
  });

  it("names a value set under a name this app never reads, instead of staying silent", () => {
    const result = run({ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(result.stdout).not.toContain("abcdefghijklmnop");
  });

  it("names a half-configured pair without calling Supabase, and never prints the value it was given", () => {
    const result = run({ SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/half-configured/);
    expect(result.stdout + result.stderr).not.toContain("abcdefghijklmnop");
  });

  it("never writes: it only lists buckets", () => {
    const source = readFileSync("scripts/verify-storage.mjs", "utf8");
    expect(source).not.toMatch(/\.upload\(|\.remove\(|createBucket|updateBucket|deleteBucket|emptyBucket/);
    expect(source).not.toMatch(/\$\{\s*(url|key)\s*\}/); // never interpolated into output
    expect(source).not.toMatch(/console\.\w+\(\s*(url|key)\b/); // never passed to the console
  });
});
