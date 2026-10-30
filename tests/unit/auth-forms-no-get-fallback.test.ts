import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Found in the Phase 6 browser pass: a sign-in form submitted before the page had hydrated (a slow phone, a blocked
 * script, a dev compile) fell back to the browser's own submit - a GET to the same URL, which put the email AND the password
 * in the address bar (`/sign-in?email=...&password=...`): into history, the server log and any Referer. A form that carries
 * a credential must never be able to take that path, so every auth form declares `method="post"` and the browser can only
 * ever send the values in a body. (The React handler still runs first once the page is live.)
 */

const roots = ["src/app/(auth)", "src/components/auth"];

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx$/.test(name) ? [path] : [];
  });

describe("forms that take a credential", () => {
  const files = roots.flatMap(sources);

  it("finds the auth forms it is meant to guard", () => {
    const forms = files.flatMap((file) => readFileSync(file, "utf8").match(/<form\b[^>]*>/g) ?? []);
    expect(forms.length).toBeGreaterThanOrEqual(6);
  });

  it("every <form> in the auth screens posts, so a submit before hydration cannot put a password in the URL", () => {
    for (const file of files) {
      for (const tag of readFileSync(file, "utf8").match(/<form\b[^>]*>/g) ?? []) {
        expect(tag, `${file}: ${tag}`).toMatch(/method="post"/);
        expect(tag, `${file}: ${tag}`).not.toMatch(/method="get"/i);
      }
    }
  });
});
