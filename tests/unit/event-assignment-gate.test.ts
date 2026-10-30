import { describe, expect, it } from "vitest";
import { memberMayOpenEvent } from "@/components/admin/event-context";

/**
 * Found in the Phase 6 browser pass: an event admin assigned to one competition could open another competition's
 * Registrations screen by address and was shown "No registrations yet", the Export button and the manual-entry panel.
 * The server and rules had already refused the data; the screen now says the person is not assigned instead.
 */
describe("who may open a competition's pages", () => {
  it("the Event Head and a legacy fest-wide account (no membership) may open any", () => {
    expect(memberMayOpenEvent({ role: "head", eventIds: [] }, "a2")).toBe(true);
    expect(memberMayOpenEvent(undefined, "a2")).toBe(true);
  });

  it("an admin, coordinator or volunteer by event role may open only what they are assigned", () => {
    for (const role of ["admin", "coordinator", "volunteer"] as const) {
      expect(memberMayOpenEvent({ role, eventIds: ["a1"] }, "a1"), role).toBe(true);
      expect(memberMayOpenEvent({ role, eventIds: ["a1"] }, "a2"), role).toBe(false);
      expect(memberMayOpenEvent({ role, eventIds: [] }, "a1"), role).toBe(false);
    }
  });
});
