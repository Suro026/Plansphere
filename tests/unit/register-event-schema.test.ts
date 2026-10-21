import { describe, expect, it } from "vitest";
import { registerEventSchema } from "@/core/models/fest";

const valid = {
  organizationName: "Westbrook Institute of Technology",
  organizationType: "college",
  contactEmail: "events@westbrook.example.edu",
  city: "Coimbatore",
  state: "Tamil Nadu",
  name: "Westbrook Tech Summit 2026",
  festType: "tech",
  startDate: "2026-11-20",
  endDate: "2026-11-22",
  venue: "Main Campus",
  expectedParticipants: "600",
  eventHead: { name: "Kiran Patel", designation: "Technical Secretary", phone: "+91 98765 40001" },
};

describe("registerEventSchema — optional URLs", () => {
  it("accepts the wizard's untouched optional fields (empty strings) as not provided", () => {
    const parsed = registerEventSchema.parse({
      ...valid,
      organizationWebsite: "",
      eventHead: { ...valid.eventHead, linkedin: "", idCardUrl: "" },
    });
    expect(parsed.organizationWebsite).toBeUndefined();
    expect(parsed.eventHead.linkedin).toBeUndefined();
    expect(parsed.eventHead.idCardUrl).toBeUndefined();
  });

  it("treats whitespace-only the same way", () => {
    const parsed = registerEventSchema.parse({ ...valid, organizationWebsite: "   ", eventHead: { ...valid.eventHead, linkedin: "  " } });
    expect(parsed.organizationWebsite).toBeUndefined();
    expect(parsed.eventHead.linkedin).toBeUndefined();
  });

  it("still validates URLs that are provided", () => {
    const ok = registerEventSchema.parse({ ...valid, organizationWebsite: "https://westbrook.example.edu", eventHead: { ...valid.eventHead, linkedin: "https://linkedin.com/in/kiran" } });
    expect(ok.organizationWebsite).toBe("https://westbrook.example.edu");
    expect(ok.eventHead.linkedin).toBe("https://linkedin.com/in/kiran");
    expect(registerEventSchema.safeParse({ ...valid, organizationWebsite: "not a url" }).success).toBe(false);
    expect(registerEventSchema.safeParse({ ...valid, eventHead: { ...valid.eventHead, linkedin: "http://insecure.example.com" } }).success).toBe(false);
    expect(registerEventSchema.safeParse({ ...valid, eventHead: { ...valid.eventHead, idCardUrl: "javascript:alert(1)" } }).success).toBe(false);
  });
});
