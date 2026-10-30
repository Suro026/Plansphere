"use client";

import * as React from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { CreateFest, Fest, UpdateFest } from "@/core/models/fest";
import { FEST_REGISTRATION_STATES, FEST_TYPES, FEST_TYPE_LABELS, FEST_VISIBILITIES, academicYearSchema, festRegistrationStateSchema, festTypeSchema, festVisibilitySchema, hexColorSchema } from "@/core/models/fest";
import { calendarDateSchema, emailSchema, shortTextSchema } from "@/core/models/common";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/field";
import { ImageUploadField } from "@/components/ui/image-upload";
import { slugify } from "@/lib/utils";

/**
 * The fest form, shared by creation and settings. Slug follows the name
 * until edited; it is locked after publishing because it is the fest's URL.
 */
export const festFormSchema = z
  .object({
    name: shortTextSchema,
    slug: z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and hyphens"),
    tagline: z.string().trim().max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    organizationName: shortTextSchema,
    venue: shortTextSchema,
    city: shortTextSchema,
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    festType: festTypeSchema,
    academicYear: z.union([academicYearSchema, z.literal("")]).optional(),
    themeColor: z.union([hexColorSchema, z.literal("")]).optional(),
    visibility: festVisibilitySchema,
    registrationState: festRegistrationStateSchema,
    bannerUrl: z.union([z.string().url("Enter a full URL").refine((v) => v.toLowerCase().startsWith("https://"), "Enter an https:// URL"), z.literal("")]).optional(),
    logoUrl: z.union([z.string().url("Enter a full URL").refine((v) => v.toLowerCase().startsWith("https://"), "Enter an https:// URL"), z.literal("")]).optional(),
    heroUrl: z.union([z.string().url("Enter a full URL").refine((v) => v.toLowerCase().startsWith("https://"), "Enter an https:// URL"), z.literal("")]).optional(),
    thumbnailUrl: z.union([z.string().url("Enter a full URL").refine((v) => v.toLowerCase().startsWith("https://"), "Enter an https:// URL"), z.literal("")]).optional(),
    socialImageUrl: z.union([z.string().url("Enter a full URL").refine((v) => v.toLowerCase().startsWith("https://"), "Enter an https:// URL"), z.literal("")]).optional(),
    contactEmail: z.union([emailSchema, z.literal("")]).optional(),
    contactPhone: z.string().trim().max(20).optional(),
  })
  .refine((f) => f.endDate >= f.startDate, { message: "Ends before it starts", path: ["endDate"] });

export type FestFormValues = z.input<typeof festFormSchema>;
export type FestFormOutput = z.output<typeof festFormSchema>;

const blank = (v?: string) => (v && v.trim() ? v.trim() : undefined);

export const toCreateFest = (v: FestFormOutput): CreateFest => ({
  name: v.name,
  slug: v.slug,
  tagline: blank(v.tagline),
  description: blank(v.description),
  organizationName: v.organizationName,
  venue: v.venue,
  city: v.city,
  startDate: v.startDate,
  endDate: v.endDate,
  festType: v.festType,
  academicYear: blank(v.academicYear),
  themeColor: blank(v.themeColor),
  visibility: v.visibility,
  registrationState: v.registrationState,
  bannerUrl: blank(v.bannerUrl),
  logoUrl: blank(v.logoUrl),
  heroUrl: blank(v.heroUrl),
  thumbnailUrl: blank(v.thumbnailUrl),
  socialImageUrl: blank(v.socialImageUrl),
  contactEmail: blank(v.contactEmail),
  contactPhone: blank(v.contactPhone),
});

export const toUpdateFest = (v: FestFormOutput): UpdateFest => {
  const { slug: _slug, ...rest } = toCreateFest(v);
  void _slug;
  return rest;
};

export const fromFest = (f: Fest): FestFormValues => ({
  name: f.name,
  slug: f.slug,
  tagline: f.tagline ?? "",
  description: f.description ?? "",
  organizationName: f.organizationName,
  venue: f.venue,
  city: f.city,
  startDate: f.startDate,
  endDate: f.endDate,
  festType: f.festType ?? "other",
  academicYear: f.academicYear ?? "",
  themeColor: f.themeColor ?? "",
  visibility: f.visibility ?? "public",
  registrationState: f.registrationState ?? "open",
  bannerUrl: f.bannerUrl ?? "",
  logoUrl: f.logoUrl ?? "",
  heroUrl: f.heroUrl ?? "",
  thumbnailUrl: f.thumbnailUrl ?? "",
  socialImageUrl: f.socialImageUrl ?? "",
  contactEmail: f.contactEmail ?? "",
  contactPhone: f.contactPhone ?? "",
});

export const emptyFest = (): FestFormValues => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  const start = d.toISOString().slice(0, 10);
  const year = new Date().getFullYear();
  return {
    name: "",
    slug: "",
    tagline: "",
    description: "",
    organizationName: "",
    venue: "",
    city: "",
    startDate: start,
    endDate: start,
    festType: "tech",
    academicYear: `${year}-${String((year + 1) % 100).padStart(2, "0")}`,
    themeColor: "",
    visibility: "public",
    registrationState: "open",
    bannerUrl: "",
    logoUrl: "",
    heroUrl: "",
    thumbnailUrl: "",
    socialImageUrl: "",
    contactEmail: "",
    contactPhone: "",
  };
};

export const useFestForm = (defaults: FestFormValues) =>
  useForm<FestFormValues, unknown, FestFormOutput>({ resolver: zodResolver(festFormSchema), defaultValues: defaults, mode: "onBlur" });

type Form = UseFormReturn<FestFormValues, unknown, FestFormOutput>;

export const FestFields = ({ form, lockSlug, festId }: { form: Form; lockSlug?: boolean; festId?: string }) => {
  const err = form.formState.errors;
  const name = form.watch("name");
  const touched = React.useRef(false);

  React.useEffect(() => {
    if (!touched.current && !lockSlug) form.setValue("slug", slugify(name ?? ""));
  }, [name, form, lockSlug]);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Fest name" htmlFor="f-name" error={err.name?.message}>
        <Input id="f-name" placeholder="Ignitia ’26" {...form.register("name")} />
      </Field>
      <Field label="Address" htmlFor="f-slug" error={err.slug?.message} hint={lockSlug ? "Locked once published — it is the fest's URL." : "plansphere.app/f/…"}>
        <Input id="f-slug" disabled={lockSlug} className="font-mono text-[13px]" {...form.register("slug", { onChange: () => (touched.current = true) })} />
      </Field>
      <Field label="Kind of fest" htmlFor="f-type" error={err.festType?.message}>
        <NativeSelect id="f-type" {...form.register("festType")}>
          {FEST_TYPES.map((t) => (
            <option key={t} value={t}>
              {FEST_TYPE_LABELS[t]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Academic year" htmlFor="f-year" error={err.academicYear?.message} hint="2025-26">
        <Input id="f-year" placeholder="2025-26" {...form.register("academicYear")} />
      </Field>
      <Field label="Tagline" htmlFor="f-tag" error={err.tagline?.message} className="sm:col-span-2">
        <Input id="f-tag" placeholder="Three days, 42 events, one pass." {...form.register("tagline")} />
      </Field>
      <Field label="Description" htmlFor="f-desc" error={err.description?.message} className="sm:col-span-2">
        <Textarea id="f-desc" rows={3} {...form.register("description")} />
      </Field>
      <Field label="Organising institution" htmlFor="f-org" error={err.organizationName?.message}>
        <Input id="f-org" placeholder="SRM Institute of Science & Technology" {...form.register("organizationName")} />
      </Field>
      <Field label="City" htmlFor="f-city" error={err.city?.message}>
        <Input id="f-city" placeholder="Chennai" {...form.register("city")} />
      </Field>
      <Field label="Venue" htmlFor="f-venue" error={err.venue?.message} className="sm:col-span-2">
        <Input id="f-venue" placeholder="Kattankulathur campus" {...form.register("venue")} />
      </Field>
      <Field label="Starts" htmlFor="f-start" error={err.startDate?.message}>
        <Input id="f-start" type="date" {...form.register("startDate")} />
      </Field>
      <Field label="Ends" htmlFor="f-end" error={err.endDate?.message}>
        <Input id="f-end" type="date" {...form.register("endDate")} />
      </Field>
      <ImageUploadField
        id="f-banner"
        label="Cover image"
        kind="festBanner"
        ownerId={festId}
        aspect="1080/1350"
        value={form.watch("bannerUrl") ?? ""}
        onChange={(url) => form.setValue("bannerUrl", url, { shouldDirty: true, shouldValidate: true })}
        error={err.bannerUrl?.message}
        hint="1080×1350 for the marquee · PNG, JPEG or WebP up to 5 MB"
      />
      <ImageUploadField
        id="f-logo"
        label="Logo"
        kind="festLogo"
        ownerId={festId}
        aspect="1/1"
        value={form.watch("logoUrl") ?? ""}
        onChange={(url) => form.setValue("logoUrl", url, { shouldDirty: true, shouldValidate: true })}
        error={err.logoUrl?.message}
        hint="Square · PNG, JPEG or WebP up to 2 MB"
      />
      <ImageUploadField
        id="f-hero"
        label="Hero poster"
        kind="festHero"
        ownerId={festId}
        aspect="1200/1600"
        value={form.watch("heroUrl") ?? ""}
        onChange={(url) => form.setValue("heroUrl", url, { shouldDirty: true, shouldValidate: true })}
        error={err.heroUrl?.message}
        hint="The tall artwork at the top of the fest page · up to 6 MB"
      />
      <ImageUploadField
        id="f-thumb"
        label="Thumbnail"
        kind="festThumbnail"
        ownerId={festId}
        aspect="4/3"
        value={form.watch("thumbnailUrl") ?? ""}
        onChange={(url) => form.setValue("thumbnailUrl", url, { shouldDirty: true, shouldValidate: true })}
        error={err.thumbnailUrl?.message}
        hint="The explorer card · 800×600 is plenty"
      />
      <ImageUploadField
        id="f-social"
        label="Social poster"
        kind="festSocial"
        ownerId={festId}
        aspect="1200/630"
        value={form.watch("socialImageUrl") ?? ""}
        onChange={(url) => form.setValue("socialImageUrl", url, { shouldDirty: true, shouldValidate: true })}
        error={err.socialImageUrl?.message}
        hint="1200×630 — what WhatsApp and X show when the link is shared"
      />
      <Field label="Theme colour" htmlFor="f-theme" error={err.themeColor?.message} hint="Hex, e.g. #cbf6df. Blank keeps the Plansphere accent.">
        <Input id="f-theme" placeholder="#cbf6df" className="font-mono text-[13px]" {...form.register("themeColor")} />
      </Field>
      <Field label="Visibility" htmlFor="f-vis" error={err.visibility?.message} hint="Unlisted is reachable by link but never listed.">
        <NativeSelect id="f-vis" {...form.register("visibility")}>
          {FEST_VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {v === "public" ? "Public — listed in Explore" : v === "unlisted" ? "Unlisted — by link only" : "Private — staff only"}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Registration" htmlFor="f-reg" error={err.registrationState?.message} hint="Closes every event in the fest at once.">
        <NativeSelect id="f-reg" {...form.register("registrationState")}>
          {FEST_REGISTRATION_STATES.map((v) => (
            <option key={v} value={v}>
              {v === "open" ? "Open" : v === "closed" ? "Closed" : "Opening soon"}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Contact email" htmlFor="f-email" error={err.contactEmail?.message}>
        <Input id="f-email" type="email" placeholder="fest@college.edu" {...form.register("contactEmail")} />
      </Field>
      <Field label="Contact phone" htmlFor="f-phone" error={err.contactPhone?.message}>
        <Input id="f-phone" type="tel" placeholder="+91" {...form.register("contactPhone")} />
      </Field>
    </div>
  );
};
