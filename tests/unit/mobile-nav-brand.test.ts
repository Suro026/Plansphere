import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Found in the Phase 6 mobile pass (375px): in the admin and volunteer headers - a nav that scrolls sideways - the brand was
 * allowed to shrink, so its role label ("EVENT HEAD") wrapped onto two lines and drew over the first link. The brand must
 * keep its width and stay on one line; the links scroll, the brand does not.
 */
describe("the header brand on a narrow screen", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const rule = css.match(/\.nav-brand\s*\{[^}]*\}/)?.[0] ?? "";

  it("does not shrink and does not wrap", () => {
    expect(rule).not.toBe("");
    expect(rule).toMatch(/flex:\s*none/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });
});

/**
 * Found in the same pass: the event head's Overview was 450px wide on a 375px phone. Its two-column grid collapses to one
 * auto-sized column on a phone, and a grid item will not shrink below its content unless told it may - so the events table
 * stretched the whole page instead of scrolling inside its own wrapper.
 */
describe("the Overview's events column on a narrow screen", () => {
  it("may shrink below its content, so the table scrolls inside itself", () => {
    const page = readFileSync("src/app/admin/[festSlug]/overview/page.tsx", "utf8");
    expect(page).toMatch(/lg:grid-cols-\[1fr_320px\]">\s*<div className="min-w-0">/);
  });
});
