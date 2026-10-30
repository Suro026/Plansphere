"use client";

import * as React from "react";
import { toast } from "sonner";
import { normalizeSport } from "@/core/services/scoring";
import type { Match, MatchSide } from "@/core/models/match";
import { Button } from "@/components/ui/button";

/**
 * The sport-specific button row. Every sport ends up calling the same
 * `onScore`, which the page wires to `MatchRepository.scoreMatch` — the
 * engine on the server decides what the tap means, this component only
 * decides which taps to offer.
 */
export const ScoreControls = ({
  match,
  onScore,
  busy,
}: {
  match: Match;
  onScore: (type: string, side?: MatchSide, payload?: Record<string, unknown>) => Promise<void>;
  busy: boolean;
}) => {
  const [pending, setPending] = React.useState<string | null>(null);

  const tap = async (key: string, type: string, side?: MatchSide, payload?: Record<string, unknown>) => {
    setPending(key);
    try {
      await onScore(type, side, payload);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't record that");
    } finally {
      setPending(null);
    }
  };

  const disabled = busy || pending !== null;
  const sport = normalizeSport(match.sportType);
  const Side = ({ side, children }: { side: MatchSide; children: React.ReactNode }) => (
    <div className="flex flex-col gap-2">
      <div className="text-center text-[12px] font-medium text-neutral-400">{side === "home" ? match.homeTeam?.name ?? "Home" : match.awayTeam?.name ?? "Away"}</div>
      {children}
    </div>
  );

  if (sport === "football" || sport === "soccer" || sport === "robo soccer" || sport === "hockey") {
    return (
      <div className="grid grid-cols-2 gap-4">
        {(["home", "away"] as const).map((side) => (
          <Side key={side} side={side}>
            <Button variant="primary" disabled={disabled} onClick={() => void tap(`${side}-goal`, "goal", side)}>
              {pending === `${side}-goal` ? "…" : "Goal"}
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={disabled} onClick={() => void tap(`${side}-yellow`, "yellow_card", side)}>
                Yellow
              </Button>
              <Button variant="secondary" disabled={disabled} onClick={() => void tap(`${side}-red`, "red_card", side)}>
                Red
              </Button>
            </div>
          </Side>
        ))}
      </div>
    );
  }

  if (sport === "cricket") {
    const battingSide = (match.score.detail as { battingSide?: MatchSide } | undefined)?.battingSide ?? "home";
    return (
      <div>
        <div className="mb-3 text-center text-[12px] text-neutral-500">
          Batting: <span className="font-medium text-neutral-300">{battingSide === "home" ? match.homeTeam?.name : match.awayTeam?.name}</span>
        </div>
        <div className="mb-2 grid grid-cols-4 gap-2 sm:grid-cols-7">
          {[0, 1, 2, 3, 4, 6].map((runs) => (
            <Button key={runs} variant="secondary" disabled={disabled} onClick={() => void tap(`run-${runs}`, "run", undefined, { runs })}>
              {pending === `run-${runs}` ? "…" : runs}
            </Button>
          ))}
          <Button variant="primary" disabled={disabled} onClick={() => void tap("wicket", "wicket")}>
            {pending === "wicket" ? "…" : "Wicket"}
          </Button>
        </div>
      </div>
    );
  }

  if (sport === "volleyball" || sport === "badminton" || sport === "table tennis") {
    return (
      <div className="grid grid-cols-2 gap-4">
        {(["home", "away"] as const).map((side) => (
          <Side key={side} side={side}>
            <Button variant="primary" disabled={disabled} onClick={() => void tap(`${side}-point`, "point", side)}>
              {pending === `${side}-point` ? "…" : "Point"}
            </Button>
          </Side>
        ))}
      </div>
    );
  }

  if (sport === "robo fight" || sport === "robowar" || sport === "robo war" || sport === "battle bots" || sport === "combat robotics") {
    return (
      <div className="grid grid-cols-2 gap-4">
        {(["home", "away"] as const).map((side) => (
          <Side key={side} side={side}>
            <Button variant="primary" disabled={disabled} onClick={() => void tap(`${side}-round`, "round_win", side)}>
              {pending === `${side}-round` ? "…" : "Round winner"}
            </Button>
            <div className="flex gap-2">
              {[1, 3, 5].map((v) => (
                <Button key={v} variant="secondary" disabled={disabled} onClick={() => void tap(`${side}-point-${v}`, "point", side, { value: v })}>
                  +{v}
                </Button>
              ))}
            </div>
          </Side>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {(["home", "away"] as const).map((side) => (
        <Side key={side} side={side}>
          <Button variant="primary" disabled={disabled} onClick={() => void tap(`${side}-point`, "point", side)}>
            {pending === `${side}-point` ? "…" : "+1"}
          </Button>
        </Side>
      ))}
    </div>
  );
};
