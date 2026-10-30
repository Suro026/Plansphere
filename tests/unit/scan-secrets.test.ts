// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ENV_TEMPLATE_FILE, envTemplateProblems } from "../../scripts/lib/env-template.mjs";

/**
 * `.env.example` used to be exempt from the secret scan on the grounds that its values are empty. Nothing checked that,
 * so a template that had real project values pasted into it (found in the Phase 10 review) would have passed CI. It is
 * now scanned like any file, and every assignment in it must be empty or one of a few harmless defaults.
 */

const NAMES = `# Firebase Web SDK (client)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_APP_URL=http://localhost:3000
FIREBASE_SERVICE_ACCOUNT=
EMAIL_PROVIDER=console
EMAIL_FROM=Plansphere <noreply@plansphere.in>
APP_CHECK_ENFORCE=false
`;

describe("env template rules", () => {
  it("accepts empty values, comments and the known harmless defaults", () => {
    expect(envTemplateProblems(NAMES)).toEqual([]);
    expect(envTemplateProblems("# NEXT_PUBLIC_FIREBASE_PROJECT_ID=not-a-real-assignment\n\n")).toEqual([]);
  });

  it("reports the line and the name of any other value, never the value", () => {
    const found = envTemplateProblems("A=\nNEXT_PUBLIC_FIREBASE_PROJECT_ID=some-project\nSUPABASE_URL='https://x.example'\n");
    expect(found).toEqual([
      { line: 2, name: "NEXT_PUBLIC_FIREBASE_PROJECT_ID" },
      { line: 3, name: "SUPABASE_URL" },
    ]);
    expect(JSON.stringify(found)).not.toContain("some-project");
  });

  it("does not accept a default name carrying a different value (a glued or edited URL)", () => {
    expect(envTemplateProblems("NEXT_PUBLIC_APP_URL=http://localhost:3000AIzaNotARealKey\n")).toEqual([{ line: 1, name: "NEXT_PUBLIC_APP_URL" }]);
    expect(envTemplateProblems("NEXT_PUBLIC_APP_URL=https://plansphere.in\n")).toEqual([{ line: 1, name: "NEXT_PUBLIC_APP_URL" }]);
  });

  it("reads CRLF files, `export` prefixes, quotes and trailing comments", () => {
    expect(envTemplateProblems("A=\r\nexport B=\"\"\r\nC='' # nothing\r\nD= # nothing\r\n")).toEqual([]);
    expect(envTemplateProblems("export B=\"x\"\r\n")).toEqual([{ line: 1, name: "B" }]);
  });

  it("recognises template file names", () => {
    for (const name of [".env.example", "config/.env.example", ".env.production.example", ".env.sample", ".env.template"]) expect(ENV_TEMPLATE_FILE.test(name)).toBe(true);
    for (const name of [".env", ".env.local", ".env.production", "src/server/env.ts", "docs/.env.examples"]) expect(ENV_TEMPLATE_FILE.test(name)).toBe(false);
  });
});

describe("scripts/scan-secrets.mjs on a tree", () => {
  const scanner = resolve(__dirname, "../../scripts/scan-secrets.mjs");
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** A throw-away repository whose index holds `.env.example` with the given content. */
  const scan = (envExample: string) => {
    const dir = mkdtempSync(join(tmpdir(), "scan-secrets-"));
    dirs.push(dir);
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    expect(git("init", "-q").status).toBe(0);
    writeFileSync(join(dir, ".env.example"), envExample);
    expect(git("add", ".env.example").status).toBe(0);
    const run = spawnSync(process.execPath, [scanner], { cwd: dir, encoding: "utf8" });
    return { code: run.status, out: `${run.stdout}${run.stderr}` };
  };

  it("passes a template of names and harmless defaults", () => {
    expect(scan(NAMES).code).toBe(0);
  });

  it("fails a template with real-looking web config values, naming the variable but not printing the value", () => {
    const value = "plansphere-secret-looking-project-id";
    const run = scan(NAMES.replace("NEXT_PUBLIC_FIREBASE_PROJECT_ID=", `NEXT_PUBLIC_FIREBASE_PROJECT_ID=${value}`));
    expect(run.code).toBe(1);
    expect(run.out).toContain("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
    expect(run.out).not.toContain(value);
  });

  it("fails a template whose APP_URL has something glued to it", () => {
    const run = scan(NAMES.replace("http://localhost:3000", `http://localhost:3000${"x".repeat(12)}`));
    expect(run.code).toBe(1);
    expect(run.out).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("fails a template holding a key-shaped value anywhere, comments included", () => {
    const fakeKey = `AIza${"a1B2c3D4".repeat(5)}`.slice(0, 39);
    const run = scan(`${NAMES}# old value: ${fakeKey}\n`);
    expect(run.code).toBe(1);
    expect(run.out).toContain("Google API key");
    expect(run.out).not.toContain(fakeKey);
  });
});
