/**
 * Bracket generation — pure functions over a list of confirmed entries.
 *
 * A knockout bracket is built once, from a standard tournament seed
 * sequence, so byes land where a real tournament would put them (spread
 * across the draw, never two in the same first-round match) rather than
 * clustered at the top. Everything downstream — arena assignment, actually
 * playing a match — happens after this runs; this only decides the shape.
 */

export interface BracketParticipant {
  registrationId: string;
  name: string;
}

export interface BracketTeam {
  registrationId?: string;
  name: string;
  isBye: boolean;
}

export interface BracketMatchDraft {
  round: number;
  roundLabel: string;
  /** Position within the round, 0-based, top to bottom. */
  matchIndex: number;
  homeTeam: BracketTeam | null;
  awayTeam: BracketTeam | null;
  /** Set only when a bye resolves the match without anyone playing it. */
  winner?: "home" | "away";
  /** Where the winner advances to. Absent on the final. */
  nextMatchRound?: number;
  nextMatchIndex?: number;
  nextMatchSlot?: "home" | "away";
}

export const nextPowerOfTwo = (n: number): number => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

/**
 * The standard bracket seeding order: seed 1 meets the lowest seed, seed 2
 * the next lowest, and so on, so a size-8 bracket pairs (1,8) (4,5) (2,7)
 * (3,6) — the same shape a real single-elimination draw uses, which is what
 * spreads byes evenly instead of stacking them against one half.
 */
export const seedPositions = (size: number): number[] => {
  if (size <= 1) return [1];
  const prev = seedPositions(size / 2);
  const out: number[] = [];
  for (const s of prev) {
    out.push(s, size + 1 - s);
  }
  return out;
};

const roundLabelFor = (matchesInRound: number): string => {
  if (matchesInRound === 1) return "Final";
  if (matchesInRound === 2) return "Semifinal";
  if (matchesInRound === 4) return "Quarterfinal";
  return `Round of ${matchesInRound * 2}`;
};

/**
 * A full single-elimination bracket, including byes, as a flat list of
 * match drafts across every round. Fewer than two participants produces no
 * bracket — there is nothing to play.
 */
export const generateKnockoutBracket = (participants: readonly BracketParticipant[]): BracketMatchDraft[] => {
  if (participants.length < 2) return [];

  const bracketSize = nextPowerOfTwo(participants.length);
  const order = seedPositions(bracketSize);
  const teamForSeed = (seed: number): BracketTeam => {
    const p = participants[seed - 1];
    return p ? { registrationId: p.registrationId, name: p.name, isBye: false } : { name: "Bye", isBye: true };
  };

  const numRounds = Math.log2(bracketSize);
  const rounds: BracketMatchDraft[][] = [];
  for (let r = 1; r <= numRounds; r += 1) {
    const matchesInRound = bracketSize / 2 ** r;
    const roundLabel = roundLabelFor(matchesInRound);
    rounds.push(
      Array.from({ length: matchesInRound }, (_, i) => ({
        round: r,
        roundLabel,
        matchIndex: i,
        homeTeam: null,
        awayTeam: null,
      })),
    );
  }

  // Round 1: pair consecutive slots from the seed order, and auto-resolve
  // any match where exactly one side is a bye — a bye never has to be
  // "played" to advance its opponent.
  const round1 = rounds[0]!;
  for (let i = 0; i < round1.length; i += 1) {
    const home = teamForSeed(order[i * 2]!);
    const away = teamForSeed(order[i * 2 + 1]!);
    round1[i]!.homeTeam = home;
    round1[i]!.awayTeam = away;
    if (home.isBye && !away.isBye) round1[i]!.winner = "away";
    else if (away.isBye && !home.isBye) round1[i]!.winner = "home";
  }

  // A bye-resolved match's winner is already known, so the round it feeds
  // into can be filled in immediately rather than waiting for a scoreboard.
  // A match that was actually decided by play is filled in later, by the
  // server when the match finishes.
  for (let r = 1; r < numRounds; r += 1) {
    const prev = rounds[r - 1]!;
    const round = rounds[r]!;
    for (let i = 0; i < round.length; i += 1) {
      const feedHome = prev[i * 2]!;
      const feedAway = prev[i * 2 + 1]!;
      round[i]!.homeTeam = feedHome.winner ? (feedHome.winner === "home" ? feedHome.homeTeam : feedHome.awayTeam) : null;
      round[i]!.awayTeam = feedAway.winner ? (feedAway.winner === "home" ? feedAway.homeTeam : feedAway.awayTeam) : null;
    }
  }

  // Wire each match to where its winner advances.
  for (let r = 1; r < numRounds; r += 1) {
    const round = rounds[r - 1]!;
    for (let i = 0; i < round.length; i += 1) {
      round[i]!.nextMatchRound = r + 1;
      round[i]!.nextMatchIndex = Math.floor(i / 2);
      round[i]!.nextMatchSlot = i % 2 === 0 ? "home" : "away";
    }
  }

  return rounds.flat();
};

/**
 * Every participant plays every other participant exactly once, all in
 * "round" 1 (round-robin standings are read off the results, not off which
 * round a match sits in) — no byes needed, since an odd count just means
 * one fixture list is one shorter than an even one.
 */
export const generateRoundRobin = (participants: readonly BracketParticipant[]): BracketMatchDraft[] => {
  if (participants.length < 2) return [];
  const drafts: BracketMatchDraft[] = [];
  let matchIndex = 0;
  for (let i = 0; i < participants.length; i += 1) {
    for (let j = i + 1; j < participants.length; j += 1) {
      const home = participants[i]!;
      const away = participants[j]!;
      drafts.push({
        round: 1,
        roundLabel: "League",
        matchIndex: matchIndex++,
        homeTeam: { registrationId: home.registrationId, name: home.name, isBye: false },
        awayTeam: { registrationId: away.registrationId, name: away.name, isBye: false },
      });
    }
  }
  return drafts;
};
