"use client";

import * as React from "react";
import { toast } from "sonner";
import { FilePdf, X } from "@phosphor-icons/react";
import { RepositoryError } from "@/core/models/common";
import { apiUpload } from "@/data/api-client";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export interface PdfUploadFieldProps {
  id: string;
  label: string;
  /** Fest id the rulebook is filed under. */
  ownerId?: string;
  value: string;
  onChange: (url: string) => void;
  error?: string;
  hint?: string;
  className?: string;
}

/**
 * A rulebook upload — the one place the app accepts a PDF from a browser.
 *
 * Deliberately not `ImageUploadField` with a different accept string: a PDF
 * cannot be decoded by sharp, previewed as an image, or safely re-encoded, so
 * it takes its own narrow path (`kind: "eventRulebook"`) straight to
 * `acceptPdfUpload`, which checks the bytes are actually a PDF and stores it
 * unmodified under a random name.
 */
export const PdfUploadField = ({ id, label, ownerId, value, onChange, error, hint, className }: PdfUploadFieldProps) => {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const query = new URLSearchParams({ kind: "eventRulebook", ...(ownerId ? { id: ownerId } : {}) });
      const result = await apiUpload<{ url: string }>(`/api/uploads?${query}`, file);
      onChange(result.url);
      toast.success("Rulebook uploaded");
    } catch (err) {
      toast.error(err instanceof RepositoryError ? err.message : "Couldn't upload that file");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <Field label={label} htmlFor={id} error={error} hint={hint ?? "PDF · up to 10 MB"} className={className}>
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          ref={input}
          id={id}
          type="file"
          accept="application/pdf"
          className="sr-only"
          disabled={!ownerId || busy}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        {value ? (
          <a href={value} target="_blank" rel="noreferrer" className="panel flex items-center gap-2 px-3 py-2 text-[13px] text-inherit no-underline hover:bg-surface">
            <FilePdf size={16} /> Rulebook.pdf
          </a>
        ) : null}
        <Button type="button" variant="secondary" size="sm" loading={busy} disabled={!ownerId} onClick={() => input.current?.click()}>
          {value ? "Replace" : "Upload PDF"}
        </Button>
        {value ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
            <X size={13} /> Remove
          </Button>
        ) : null}
        {!ownerId ? <span className="text-[12px] text-neutral-500">Save first, then upload.</span> : null}
      </div>
    </Field>
  );
};
