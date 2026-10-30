import { describe, expect, it } from "vitest";
import { generateKnockoutBracket, generateRoundRobin, nextPowerOfTwo, seedPositions, type BracketParticipant } from "@/core/services/bracket";

const teams = (n: number): BracketParticipant[] => Array.from({ length: n }, (_, i) => ({ registrationId: `r${i + 1}`, name: `Team ${i + 1}` }));

describe("nextPowerOfTwo", () => {
  it("rounds up to the next power of two, and leaves one alone", () => {
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(2)).toBe(2);
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(5)).toBe(8);
    expect(nextPowerOfTwo(8)).toBe(8);
    expect(nextPowerOfTwo(9)).toBe(16);
    expect(nextPowerOfTwo(17)).toBe(32);
  });
});

describe("seedPositions", () => {
  it("produces the standard bracket seeding order", () => {
    expect(seedPositions(2)).toEqual([1, 2]);
    expect(seedPositions(4)).toEqual([1, 4, 2, 3]);
    expect(seedPositions(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("pairs sum to size + 1 for every consecutive pair", () => {
    const order = seedPositions(16);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]! + order[i + 1]!).toBe(17);
    }
  });
});

describe("generateKnockoutBracket — shape", () => {
  it("produces nothing for fewer than two participants", () => {
    expect(generateKnockoutBracket([])).toEqual([]);
    expect(generateKnockoutBracket(teams(1))).toEqual([]);
  });

  it("builds a full bracket with no byes for an exact power of two", () => {
    const draft = generateKnockoutBracket(teams(8));
    const rounds = new Set(draft.map((m) => m.round));
    expect(rounds.size).toBe(3); // Round of 8 (quarters), semis, final
    expect(draft.filter((m) => m.round === 1)).toHaveLength(4);
    expect(draft.filter((m) => m.round === 2)).toHaveLength(2);
    expect(draft.filter((m) => m.round === 3)).toHaveLength(1);
    expect(draft.every((m) => !m.homeTeam?.isBye && !m.awayTeam?.isBye)).toBe(true);
  });

  it("labels rounds the way a bracket names them", () => {
    const draft = generateKnockoutBracket(teams(16));
    expect(draft.find((m) => m.round === 1)!.roundLabel).toBe("Round of 16");
    expect(draft.find((m) => m.round === 2)!.roundLabel).toBe("Quarterfinal");
    expect(draft.find((m) => m.round === 3)!.roundLabel).toBe("Semifinal");
    expect(draft.find((m) => m.round === 4)!.roundLabel).toBe("Final");
  });

  it("has exactly one final", () => {
    for (const n of [2, 3, 5, 8, 9, 13, 16, 17]) {
      const draft = generateKnockoutBracket(teams(n));
      const finals = draft.filter((m) => m.roundLabel === "Final");
      expect(finals).toHaveLength(1);
    }
  });
});

describe("generateKnockoutBracket — byes", () => {
  it("pads a 5-team draw to 8 with three byes, one per first-round match at most", () => {
    const draft = generateKnockoutBracket(teams(5));
    const round1 = draft.filter((m) => m.round === 1);
    expect(round1).toHaveLength(4);
    const byeCount = round1.filter((m) => m.homeTeam?.isBye || m.awayTeam?.isBye).length;
    expect(byeCount).toBe(3);
    // No match has both sides as a bye.
    expect(round1.every((m) => !(m.homeTeam?.isBye && m.awayTeam?.isBye))).toBe(true);
  });

  it("auto-resolves a bye match's winner without anyone playing it", () => {
    const draft = generateKnockoutBracket(teams(3));
    const byeMatch = draft.find((m) => m.round === 1 && (m.homeTeam?.isBye || m.awayTeam?.isBye));
    expect(byeMatch).toBeDefined();
    expect(byeMatch!.winner).toBeDefined();
    const realSide = byeMatch!.homeTeam?.isBye ? "away" : "home";
    expect(byeMatch!.winner).toBe(realSide);
  });

  it("carries a bye's winner straight into the next round", () => {
    const draft = generateKnockoutBracket(teams(3));
    const byeMatch = draft.find((m) => m.round === 1 && (m.homeTeam?.isBye || m.awayTeam?.isBye))!;
    const advanced = byeMatch.winner === "home" ? byeMatch.homeTeam : byeMatch.awayTeam;
    const next = draft.find((m) => m.round === byeMatch.nextMatchRound && m.matchIndex === byeMatch.nextMatchIndex)!;
    const slot = byeMatch.nextMatchSlot === "home" ? next.homeTeam : next.awayTeam;
    expect(slot?.registrationId).toBe(advanced?.registrationId);
  });

  it("leaves a real first-round match's next-round slot empty until it is played", () => {
    const draft = generateKnockoutBracket(teams(4));
    const round1 = draft.filter((m) => m.round === 1);
    expect(round1.every((m) => !m.winner)).toBe(true);
    const final = draft.find((m) => m.roundLabel === "Final")!;
    expect(final.homeTeam).toBeNull();
    expect(final.awayTeam).toBeNull();
  });

  it("needs no byes at all for an exact power of two", () => {
    const draft = generateKnockoutBracket(teams(16));
    expect(draft.some((m) => m.homeTeam?.isBye || m.awayTeam?.isBye)).toBe(false);
  });
});

describe("generateKnockoutBracket — advancement wiring", () => {
  it("every non-final match points at a slot in the next round", () => {
    const draft = generateKnockoutBracket(teams(8));
    const byRound = (r: number) => draft.filter((m) => m.round === r);
    for (const round of [1, 2]) {
      for (const match of byRound(round)) {
        expect(match.nextMatchRound).toBe(round + 1);
        expect(match.nextMatchIndex).toBeGreaterThanOrEqual(0);
        expect(["home", "away"]).toContain(match.nextMatchSlot);
      }
    }
    for (const match of byRound(3)) {
      expect(match.nextMatchRound).toBeUndefined();
    }
  });

  it("two adjacent first-round matches feed the same second-round match, into different slots", () => {
    const draft = generateKnockoutBracket(teams(8));
    const round1 = draft.filter((m) => m.round === 1).sort((a, b) => a.matchIndex - b.matchIndex);
    expect(round1[0]!.nextMatchIndex).toBe(round1[1]!.nextMatchIndex);
    expect(round1[0]!.nextMatchSlot).not.toBe(round1[1]!.nextMatchSlot);
  });
});

describe("generateRoundRobin", () => {
  it("pairs everyone with everyone else exactly once", () => {
    const draft = generateRoundRobin(teams(4));
    expect(draft).toHaveLength(6); // C(4,2)
    const pairs = new Set(draft.map((m) => [m.homeTeam!.name, m.awayTeam!.name].sort().join(" vs ")));
    expect(pairs.size).toBe(6);
  });

  it("produces nothing for fewer than two participants", () => {
    expect(generateRoundRobin(teams(1))).toEqual([]);
  });

  it("has no byes", () => {
    const draft = generateRoundRobin(teams(5));
    expect(draft.every((m) => !m.homeTeam!.isBye && !m.awayTeam!.isBye)).toBe(true);
  });
});
