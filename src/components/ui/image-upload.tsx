"use client";

import * as React from "react";
import { toast } from "sonner";
import { RepositoryError } from "@/core/models/common";
import { apiUpload } from "@/data/api-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Artwork } from "@/components/ui/primitives";

export type UploadKind =
  | "festBanner"
  | "festLogo"
  | "festHero"
  | "festThumbnail"
  | "festSocial"
  | "eventPoster"
  | "eventTeamPhoto"
  | "eventRulebook"
  | "certificateTemplate"
  | "profilePhoto";

const LIMITS: Record<UploadKind, string> = {
  festBanner: "PNG, JPEG or WebP · up to 5 MB",
  festLogo: "PNG, JPEG or WebP · up to 2 MB",
  festHero: "PNG, JPEG or WebP · up to 6 MB",
  festThumbnail: "PNG, JPEG or WebP · up to 3 MB",
  festSocial: "PNG, JPEG or WebP · up to 3 MB",
  certificateTemplate: "PNG, JPEG or WebP · up to 8 MB",
  eventPoster: "PNG, JPEG or WebP · up to 5 MB",
  eventTeamPhoto: "PNG, JPEG or WebP · up to 3 MB",
  eventRulebook: "PDF · up to 10 MB",
  profilePhoto: "PNG, JPEG or WebP · up to 3 MB",
};

export interface ImageUploadFieldProps {
  label: string;
  kind: UploadKind;
  /** Fest id for fest-owned kinds; omitted for profile photos. */
  ownerId?: string;
  value: string;
  onChange: (url: string) => void;
  error?: string;
  hint?: string;
  /** Preview aspect ratio, e.g. "1200/630". */
  aspect?: string;
  className?: string;
  /** Fall back to a URL box when the upload path is not available (e.g. a new fest with no id yet). */
  allowUrl?: boolean;
  id: string;
}

/**
 * An image field that uploads through /api/uploads and stores the returned
 * https URL in the form. The server sniffs the bytes, strips metadata and
 * names the file; this component only picks, previews and reports.
 */
export const ImageUploadField = ({ label, kind, ownerId, value, onChange, error, hint, aspect = "16/9", className, allowUrl = true, id }: ImageUploadFieldProps) => {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const canUpload = kind === "profilePhoto" || Boolean(ownerId);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const query = new URLSearchParams({ kind, ...(ownerId ? { id: ownerId } : {}) });
      const result = await apiUpload<{ url: string; width?: number; height?: number }>(`/api/uploads?${query}`, file);
      onChange(result.url);
      toast.success(result.width ? `Uploaded · ${result.width}×${result.height}` : "Uploaded");
    } catch (err) {
      toast.error(err instanceof RepositoryError ? err.message : "Couldn’t upload that image");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <Field label={label} htmlFor={id} error={error} hint={hint ?? LIMITS[kind]} className={className}>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start">
        <div className="w-full flex-none overflow-hidden rounded-md sm:w-[180px]" style={{ aspectRatio: aspect }}>
          <Artwork src={value || null} alt="" lighten={false} className="h-full w-full" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              id={id}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              disabled={!canUpload || busy}
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <Button type="button" variant="secondary" size="sm" loading={busy} disabled={!canUpload} onClick={() => input.current?.click()}>
              {value ? "Replace image" : "Upload image"}
            </Button>
            {value ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
                Remove
              </Button>
            ) : null}
          </div>
          {!canUpload ? <div className="text-[12px] text-neutral-500">Save first, then upload — the image is filed under the fest.</div> : null}
          {allowUrl ? (
            <Input
              aria-label={`${label} URL`}
              type="url"
              placeholder="or paste an https:// image URL"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="text-[12.5px]"
            />
          ) : null}
        </div>
      </div>
    </Field>
  );
};
