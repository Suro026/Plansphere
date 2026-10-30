"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/data/api-client";
import { joinCodeSchema, type Registration } from "@/core/models/registration";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Kick } from "@/components/ui/primitives";

/**
 * Join a team with a code.
 *
 * The other half of team assembly. An invitation needs the leader to know
 * your address; a code works across a room. Typing it *is* the acceptance —
 * there is no second confirmation step, because reading a code off someone's
 * screen and typing it in is already a deliberate act.
 */
export const JoinTeam = ({ className }: { className?: string }) => {
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const client = useQueryClient();
  const router = useRouter();

  const join = useMutation({
    mutationFn: (value: string) =>
      api<{ registration: Registration; joined: boolean }>("/api/registrations/join", { method: "POST", body: { code: value } }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["my-entries"] });
      setCode("");
      toast.success(
        result.joined
          ? `You're on ${result.registration.teamName ?? "the team"}`
          : `You were already on ${result.registration.teamName ?? "that team"}`,
      );
      router.push(`/registered/${result.registration.id}`);
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "That code didn't work.");
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const parsed = joinCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError("A join code is six letters and numbers.");
      return;
    }

    join.mutate(parsed.data);
  };

  return (
    <section className={className}>
      <Kick className="mb-2">Have a code?</Kick>
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2">
        <Field label="Team join code" htmlFor="join-code" error={error ?? undefined} className="min-w-[200px] flex-1">
          <Input
            id="join-code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="K7M2P9"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={6}
            inputMode="text"
            className="font-mono tracking-[0.2em]"
            invalid={Boolean(error)}
          />
        </Field>
        <Button type="submit" variant="secondary" loading={join.isPending} disabled={code.length !== 6}>
          Join team
        </Button>
      </form>
      <p className="mt-1.5 text-[11.5px] text-neutral-500">
        Your team leader can read it off their team card. Joining counts as accepting — you take one of the team&rsquo;s seats.
      </p>
    </section>
  );
};
