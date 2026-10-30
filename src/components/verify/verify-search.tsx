"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

/** Certificate-number entry. Normalizes what people paste (spaces, lowercase). */
export const VerifySearch = ({ initial = "" }: { initial?: string }) => {
  const router = useRouter();
  const [value, setValue] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const number = value.trim().toUpperCase().replace(/\s+/g, "");
    if (!/^(?:PS|FF)-\d{4}-[0-9A-HJ-NP-Z]{8}$/.test(number)) {
      setError("A certificate number looks like PS-2026-7K2M9QX4.");
      return;
    }
    setError(null);
    router.push(`/verify/${number}`);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field label="Certificate number" htmlFor="certificate-number" error={error ?? undefined} className="flex-1">
        <Input id="certificate-number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="PS-2026-7K2M9QX4" autoCapitalize="characters" autoComplete="off" spellCheck={false} className="code" />
      </Field>
      <Button type="submit" variant="primary">
        Verify
      </Button>
    </form>
  );
};
