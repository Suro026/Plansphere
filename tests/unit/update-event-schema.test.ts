import { describe, expect, it } from "vitest";
import { updateEventSchema } from "@/core/models/event";

describe("updateEventSchema", () => {
  it("keeps a status-only update status-only — no defaults are injected for missing fields", () => {
    expect(updateEventSchema.parse({ status: "completed" })).toEqual({ status: "completed" });
  });

  it("still validates and passes through the fields that are sent", () => {
    expect(updateEventSchema.parse({ capacity: 150, registrationOpen: false })).toEqual({ capacity: 150, registrationOpen: false });
    expect(updateEventSchema.safeParse({ capacity: -1 }).success).toBe(false);
  });
});
