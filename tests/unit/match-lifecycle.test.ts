import { describe, expect, it } from "vitest";
import { decideWinner } from "@/core/services/match-lifecycle";

describe("decideWinner", () => {
  it("picks the higher score", () => {
    expect(decideWinner({ home: 3, away: 1 })).toBe("home");
    expect(decideWinner({ home: 1, away: 3 })).toBe("away");
  });

  it("is undecidable on a tie with no explicit call", () => {
    expect(decideWinner({ home: 2, away: 2 })).toBeNull();
  });

  it("an explicit call always wins, even against the score", () => {
    expect(decideWinner({ home: 5, away: 1 }, "away")).toBe("away");
  });
});
