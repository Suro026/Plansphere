"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeSlash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Kick, Tag } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/**
 * The credentials of a just-created account, shown once.
 *
 * This is the only moment the temporary password exists outside the email
 * that carries it — Firebase keeps a hash and Plansphere writes nothing. So the
 * panel is deliberately loud, offers copy buttons for each part, and starts
 * with the password masked: super admins create accounts with a colleague
 * looking over their shoulder more often than not.
 */

export interface Credentials {
  id: string;
  name?: string;
  email: string;
  staffCode?: string | null;
  temporaryPassword: string;
  setPasswordLink?: string;
  emailed: boolean;
  provider?: string;
}

const CopyRow = ({ label, value, mono, secret }: { label: string; value: string; mono?: boolean; secret?: boolean }) => {
  const [shown, setShown] = React.useState(!secret);
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't reach the clipboard — select the text instead.");
    }
  };

  return (
    <div className="flex items-center gap-2 border-t border-divider py-2 first:border-t-0">
      <span className="w-[116px] flex-none text-[12px] text-neutral-500">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px]", mono && "font-mono")}>
        {shown ? value : "•".repeat(Math.min(value.length, 18))}
      </span>
      {secret ? (
        <button
          type="button"
          className="btn btn-ghost px-2 text-[12px]"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
        >
          {shown ? <EyeSlash size={14} /> : <Eye size={14} />}
        </button>
      ) : null}
      <button type="button" className="btn btn-ghost px-2 text-[12px]" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
};

export const CredentialsPanel = ({
  credentials,
  onDismiss,
  className,
}: {
  credentials: Credentials;
  onDismiss: () => void;
  className?: string;
}) => (
  <section
    className={cn("panel p-4 shadow-[inset_0_0_0_1px_var(--color-accent)]", className)}
    aria-label="Account credentials"
  >
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <Kick>Credentials — shown once</Kick>
      {credentials.emailed ? <Tag tone="accent">Emailed</Tag> : <Tag tone="outline">Not emailed — pass these on yourself</Tag>}
    </div>

    <p className="mb-3 max-w-[64ch] text-[13px] text-neutral-400">
      {credentials.name ? `${credentials.name} can ` : "They can "}
      sign in at the same address as everyone else and will be asked to choose their own password immediately.
      {credentials.emailed ? "" : ` No email provider is configured (${credentials.provider ?? "console"}), so this is the only copy.`}
    </p>

    <div className="rounded-md bg-bg/40 px-3">
      {credentials.staffCode ? <CopyRow label="Admin ID" value={credentials.staffCode} mono /> : null}
      <CopyRow label="Email" value={credentials.email} />
      <CopyRow label="Temporary password" value={credentials.temporaryPassword} mono secret />
      {credentials.setPasswordLink ? <CopyRow label="Set-password link" value={credentials.setPasswordLink} /> : null}
    </div>

    <div className="mt-3 flex justify-end">
      <Button variant="secondary" size="sm" onClick={onDismiss}>
        Done — hide this
      </Button>
    </div>
  </section>
);
