"use client";

import * as React from "react";
import { useFieldArray, useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, X } from "@phosphor-icons/react";
import {
  EVENT_CATEGORIES,
  MEAL_TYPES_LIST,
  categoryLabel,
  type CreateEvent,
  type Event,
  type UpdateEvent,
} from "@/core/models/event";
import { calendarDateSchema, clockTimeSchema, emailSchema } from "@/core/models/common";
import { CheckOption, Field, Input, NativeSelect, RadioOption, Textarea } from "@/components/ui/field";
import { ImageUploadField } from "@/components/ui/image-upload";
import { PdfUploadField } from "@/components/ui/pdf-upload";
import { Button } from "@/components/ui/button";
import { Kick } from "@/components/ui/primitives";
import { api } from "@/data/api-client";
import { EventCard } from "@/components/event/event-card";
import { slugify } from "@/lib/utils";

/**
 * The event form.
 *
 * Text-area lists (rules, prizes, gates) are one item per line, which is how
 * an organizer pastes them from a doc; they become arrays on submit. Numbers
 * come through `valueAsNumber`. The same sections render as wizard steps on
 * creation and as a settings page afterwards.
 */

const httpsOrBlank = z.union([z.string().url("Enter a full URL").refine((v) => v.toLowerCase().startsWith("https://"), "Enter an https:// URL"), z.literal("")]).optional();

export const eventFormSchema = z
  .object({
    title: z.string().trim().min(1, "Give the event a title").max(200),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and hyphens"),
    description: z.string().trim().max(5000).optional(),
    category: z.string().trim().min(1, "Pick or type a category").max(60),
    visibility: z.enum(["public", "unlisted", "archived"]),
    venue: z.string().trim().min(1, "Where is it held?").max(200),
    date: calendarDateSchema,
    startTime: clockTimeSchema,
    endTime: z.union([clockTimeSchema, z.literal("")]).optional(),
    posterUrl: z.union([z.string().url("Enter a full URL").refine((v) => v.toLowerCase().startsWith("https://"), "Enter an https:// URL"), z.literal("")]).optional(),
    rulebookUrl: z.union([z.string().url("Enter a full URL").refine((v) => v.toLowerCase().startsWith("https://"), "Enter an https:// URL"), z.literal("")]).optional(),
    prizePool: z.string().trim().max(200).optional(),
    rulesText: z.string().max(10000).optional(),
    prizesText: z.string().max(4000).optional(),
    coordinators: z
      .array(
        z.object({
          name: z.string().trim().min(1, "Name").max(200),
          phone: z.string().trim().max(20).optional(),
          email: z.union([emailSchema, z.literal("")]).optional(),
          role: z.string().trim().max(80).optional(),
          photoUrl: httpsOrBlank,
          linkedinUrl: httpsOrBlank,
          websiteUrl: httpsOrBlank,
        }),
      )
      .max(10),

    eventType: z.enum(["solo", "team"]),
    teamMin: z.number().int().min(1).max(50),
    teamMax: z.number().int().min(1).max(50),

    capacity: z.number().int().min(0).max(100000),
    registrationDeadline: z.union([calendarDateSchema, z.literal("")]).optional(),
    registrationOpen: z.boolean(),
    waitlistEnabled: z.boolean(),
    entryFee: z.number().int().min(0).max(1000000),
    paymentEnabled: z.boolean(),

    gatesText: z.string().max(2000).optional(),
    mealSlots: z
      .array(
        z.object({
          date: calendarDateSchema,
          mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]),
          label: z.string().trim().min(1, "Label").max(200),
        }),
      )
      .max(30),

    status: z.enum(["draft", "published", "ongoing", "completed", "cancelled"]),
  })
  .superRefine((v, ctx) => {
    if (v.eventType === "team" && v.teamMax < 2) {
      ctx.addIssue({ code: "custom", path: ["teamMax"], message: "A team event needs a maximum size of at least 2" });
    }
    if (v.teamMax < v.teamMin) {
      ctx.addIssue({ code: "custom", path: ["teamMax"], message: "Max can't be smaller than min" });
    }
    if (v.endTime && v.endTime < v.startTime) {
      ctx.addIssue({ code: "custom", path: ["endTime"], message: "Ends before it starts" });
    }
  });

export type EventFormValues = z.input<typeof eventFormSchema>;
export type EventFormOutput = z.output<typeof eventFormSchema>;

const lines = (text?: string) =>
  (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export const toCreateEvent = (v: EventFormOutput, festId: string): CreateEvent => ({
  festId,
  title: v.title,
  slug: v.slug,
  description: v.description || undefined,
  category: v.category,
  visibility: v.visibility,
  venue: v.venue,
  date: v.date,
  startTime: v.startTime,
  endTime: v.endTime || undefined,
  posterUrl: v.posterUrl || undefined,
  rulebookUrl: v.rulebookUrl || undefined,
  prizePool: v.prizePool || undefined,
  rules: lines(v.rulesText),
  prizes: lines(v.prizesText),
  coordinators: v.coordinators.map((c) => ({ name: c.name, phone: c.phone || undefined, email: c.email || undefined, role: c.role || undefined, photoUrl: c.photoUrl || undefined, linkedinUrl: c.linkedinUrl || undefined, websiteUrl: c.websiteUrl || undefined })),
  eventType: v.eventType,
  teamSize: v.eventType === "solo" ? { min: 1, max: 1 } : { min: v.teamMin, max: v.teamMax },
  capacity: v.capacity,
  registrationDeadline: v.registrationDeadline || undefined,
  registrationOpen: v.registrationOpen,
  waitlistEnabled: v.waitlistEnabled,
  entryFee: v.entryFee,
  paymentEnabled: v.paymentEnabled,
  gates: lines(v.gatesText),
  mealSlots: v.mealSlots,
  status: v.status,
  // Live mode is configured separately, from the event's own live-settings
  // page, once there is a rulebook and a bracket to turn on — this form
  // only ever creates it off.
  liveEnabled: false,
});

export const toUpdateEvent = (v: EventFormOutput): UpdateEvent => {
  const { festId: _f, ...rest } = toCreateEvent(v, "x");
  void _f;
  return rest;
};

export const fromEvent = (event: Event): EventFormValues => ({
  title: event.title,
  slug: event.slug,
  description: event.description ?? "",
  category: event.category,
  visibility: event.visibility ?? "public",
  venue: event.venue,
  date: event.date,
  startTime: event.startTime,
  endTime: event.endTime ?? "",
  posterUrl: event.posterUrl ?? "",
  rulebookUrl: event.rulebookUrl ?? "",
  prizePool: event.prizePool ?? "",
  rulesText: event.rules.join("\n"),
  prizesText: event.prizes.join("\n"),
  coordinators: event.coordinators.map((c) => ({ name: c.name, phone: c.phone ?? "", email: c.email ?? "", role: c.role ?? "", photoUrl: c.photoUrl ?? "", linkedinUrl: c.linkedinUrl ?? "", websiteUrl: c.websiteUrl ?? "" })),
  eventType: event.eventType,
  teamMin: event.teamSize.min,
  teamMax: event.teamSize.max,
  capacity: event.capacity,
  registrationDeadline: event.registrationDeadline ?? "",
  registrationOpen: event.registrationOpen,
  waitlistEnabled: event.waitlistEnabled,
  entryFee: event.entryFee,
  paymentEnabled: event.paymentEnabled,
  gatesText: event.gates.join("\n"),
  mealSlots: event.mealSlots,
  status: event.status,
});

export const emptyEvent = (festStart: string): EventFormValues => ({
  title: "",
  slug: "",
  description: "",
  category: "technical",
  visibility: "public",
  venue: "",
  date: festStart,
  startTime: "10:00",
  endTime: "",
  posterUrl: "",
  rulebookUrl: "",
  prizePool: "",
  rulesText: "",
  prizesText: "",
  coordinators: [],
  eventType: "solo",
  teamMin: 1,
  teamMax: 1,
  capacity: 0,
  registrationDeadline: "",
  registrationOpen: true,
  waitlistEnabled: false,
  entryFee: 0,
  paymentEnabled: false,
  gatesText: "",
  mealSlots: [],
  status: "draft",
});

export const useEventForm = (defaults: EventFormValues) =>
  useForm<EventFormValues, unknown, EventFormOutput>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: defaults,
    mode: "onBlur",
  });

type Form = UseFormReturn<EventFormValues, unknown, EventFormOutput>;

/* ───────────── sections ───────────── */

export const BasicsFields = ({ form, lockSlug, festId }: { form: Form; lockSlug?: boolean; festId?: string }) => {
  const err = form.formState.errors;
  const title = form.watch("title");
  const slugTouched = React.useRef(false);

  // Slug follows the title until someone edits it by hand.
  React.useEffect(() => {
    if (!slugTouched.current && !lockSlug) form.setValue("slug", slugify(title ?? ""), { shouldValidate: false });
  }, [title, form, lockSlug]);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Title" htmlFor="ev-title" error={err.title?.message} className="sm:col-span-2">
        <Input id="ev-title" placeholder="Codeflow 12hr Hackathon" {...form.register("title")} />
      </Field>
      <Field
        label="Address"
        htmlFor="ev-slug"
        error={err.slug?.message}
        hint={lockSlug ? "Changing this breaks links already shared." : "Used in the event's URL."}
        className="sm:col-span-2"
      >
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-[12px] text-neutral-500">/e/</span>
          <Input
            id="ev-slug"
            {...form.register("slug", { onChange: () => (slugTouched.current = true) })}
            className="font-mono text-[13px]"
          />
        </div>
      </Field>
      <Field label="Description" htmlFor="ev-desc" error={err.description?.message} className="sm:col-span-2">
        <Textarea id="ev-desc" rows={3} placeholder="What it is, who it's for, what happens on the day." {...form.register("description")} />
      </Field>
      <Field label="Category" htmlFor="ev-cat" error={err.category?.message} hint="Pick one, or type your own.">
        <Input id="ev-cat" list="ev-cat-options" {...form.register("category")} />
        <datalist id="ev-cat-options">
          {EVENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </datalist>
      </Field>
      <Field label="Venue" htmlFor="ev-venue" error={err.venue?.message}>
        <Input id="ev-venue" placeholder="Tech Park Auditorium" {...form.register("venue")} />
      </Field>
      <Field label="Date" htmlFor="ev-date" error={err.date?.message}>
        <Input id="ev-date" type="date" {...form.register("date")} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts" htmlFor="ev-start" error={err.startTime?.message}>
          <Input id="ev-start" type="time" {...form.register("startTime")} />
        </Field>
        <Field label="Ends" htmlFor="ev-end" error={err.endTime?.message}>
          <Input id="ev-end" type="time" {...form.register("endTime")} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Kick className="mb-[9px]">Visibility</Kick>
        <div className="flex flex-wrap gap-[18px]">
          <RadioOption label="Public — listed on the fest page" value="public" {...form.register("visibility")} />
          <RadioOption label="Unlisted — reachable by link only" value="unlisted" {...form.register("visibility")} />
        </div>
        <div className="mt-[9px] text-[12px] text-neutral-500">Archiving is a separate action, from the danger zone below — it needs no re-save.</div>
      </div>
      <ImageUploadField
        id="ev-poster"
        label="Banner image"
        kind="eventPoster"
        ownerId={festId}
        aspect="1200/630"
        value={form.watch("posterUrl") ?? ""}
        onChange={(url) => form.setValue("posterUrl", url, { shouldDirty: true, shouldValidate: true })}
        error={err.posterUrl?.message}
        hint="1200×630 works best · PNG, JPEG or WebP up to 5 MB"
        className="sm:col-span-2"
      />
      <PdfUploadField
        id="ev-rulebook"
        label="Rulebook PDF"
        ownerId={festId}
        value={form.watch("rulebookUrl") ?? ""}
        onChange={(url) => form.setValue("rulebookUrl", url, { shouldDirty: true, shouldValidate: true })}
        error={err.rulebookUrl?.message}
        className="sm:col-span-2"
      />
      <Field label="Prize pool" htmlFor="ev-pool" hint="Shown as a headline — line items go below." className="sm:col-span-2">
        <Input id="ev-pool" placeholder="₹60,000 across three places" {...form.register("prizePool")} />
      </Field>
      <Field label="Rules" htmlFor="ev-rules" hint="One per line." className="sm:col-span-2">
        <Textarea id="ev-rules" rows={4} {...form.register("rulesText")} />
      </Field>
      <Field label="Prizes" htmlFor="ev-prizes" hint="One per line." className="sm:col-span-2">
        <Textarea id="ev-prizes" rows={2} placeholder="Winner: ₹30,000. Runner-up: ₹15,000." {...form.register("prizesText")} />
      </Field>
    </div>
  );
};

interface FestPaymentsView {
  platform: { enabled: boolean };
  account: { status: string; mode: string } | null;
  available: boolean;
  blocker: string | null;
}

/**
 * Whether this fest can take online payment right now. Loaded only when a fest
 * id is given, and any failure (no permission, offline) reads as "not available"
 * rather than hiding the rest of the form.
 */
const useFestPayments = (festId: string | undefined) => {
  const [view, setView] = React.useState<FestPaymentsView | null>(null);
  React.useEffect(() => {
    if (!festId) return;
    let live = true;
    api<FestPaymentsView>(`/api/admin/fests/${festId}/payments`)
      .then((v) => live && setView(v))
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [festId]);
  return view;
};

export const RegistrationFields = ({ form, locked, festId }: { form: Form; locked?: { teamSize?: boolean; minCapacity?: number; payment?: boolean }; festId?: string }) => {
  const err = form.formState.errors;
  const type = form.watch("eventType");
  const payments = useFestPayments(festId);
  const online = form.watch("paymentEnabled");

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Kick className="mb-[9px]">Entry type</Kick>
        <div className="flex flex-wrap items-end gap-[18px]">
          <RadioOption label="Solo" value="solo" disabled={locked?.teamSize} {...form.register("eventType")} />
          <RadioOption label="Team" value="team" disabled={locked?.teamSize} {...form.register("eventType")} />
          {type === "team" ? (
            <div className="flex gap-[9px]">
              <Field label="Min size" htmlFor="ev-min" error={err.teamMin?.message} className="w-[104px]">
                <Input id="ev-min" type="number" min={1} max={50} disabled={locked?.teamSize} {...form.register("teamMin", { valueAsNumber: true })} />
              </Field>
              <Field label="Max size" htmlFor="ev-max" error={err.teamMax?.message} className="w-[104px]">
                <Input id="ev-max" type="number" min={1} max={50} disabled={locked?.teamSize} {...form.register("teamMax", { valueAsNumber: true })} />
              </Field>
            </div>
          ) : null}
        </div>
        <div className="mt-[9px] text-[12px] text-neutral-500">
          {locked?.teamSize
            ? "Team size is locked — a team has already registered."
            : "A team event needs a maximum size of at least 2. A team consumes seats equal to its member count."}
        </div>
      </div>

      <Field
        label="Capacity (0 = unlimited)"
        htmlFor="ev-cap"
        error={err.capacity?.message}
        hint={locked?.minCapacity ? `${locked.minCapacity} seats already taken — raising is safe, lowering below that is refused.` : undefined}
      >
        <Input id="ev-cap" type="number" min={0} {...form.register("capacity", { valueAsNumber: true })} />
      </Field>
      <Field label="Registration closes" htmlFor="ev-deadline" error={err.registrationDeadline?.message} hint="Stays open through the whole day.">
        <Input id="ev-deadline" type="date" {...form.register("registrationDeadline")} />
      </Field>
      <Field
        label="Entry fee (₹, 0 = free)"
        htmlFor="ev-fee"
        error={err.entryFee?.message}
        hint={online ? "Charged once per registration — a team pays once. Plansphere adds no fee or commission." : "Shown to students. Turn on online payment to collect it through Plansphere."}
      >
        <Input id="ev-fee" type="number" min={0} disabled={locked?.payment && online} {...form.register("entryFee", { valueAsNumber: true })} />
      </Field>
      <div className="flex flex-col gap-2.5 pt-1">
        <CheckOption label="Registration open" description="Turn off to pause sign-ups without changing the deadline." {...form.register("registrationOpen")} />
        <CheckOption label="Waitlist when full" description="Entries beyond capacity queue up and are promoted automatically when a seat frees." {...form.register("waitlistEnabled")} />
      </div>
      {festId ? (
        <div className="sm:col-span-2">
          <CheckOption
            label="Collect the entry fee online"
            description={
              locked?.payment
                ? "Locked — someone has already registered."
                : payments?.available
                  ? "Students pay when they register; the seat is held for a few minutes while they do. Free events don’t need this."
                  : `Needs a fest payment account approved by the platform administrator. ${payments?.blocker ?? "Online payment isn’t set up for this fest yet."}`
            }
            disabled={locked?.payment || (!payments?.available && !online)}
            {...form.register("paymentEnabled")}
          />
          {online && !payments?.available ? (
            <div className="mt-2 text-[12px] text-neutral-500">You can save this as a draft, but it can’t be published until the payment account is approved.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const ScanningFields = ({ form }: { form: Form }) => {
  const slots = useFieldArray({ control: form.control, name: "mealSlots" });
  const err = form.formState.errors;
  const date = form.watch("date");

  return (
    <div className="flex flex-col gap-4">
      <Field label="Gates" htmlFor="ev-gates" hint="One per line. Volunteers pick their post from this list.">
        <Textarea id="ev-gates" rows={2} placeholder={"Gate A\nGate B"} {...form.register("gatesText")} />
      </Field>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <Kick>Meal slots</Kick>
          <Button variant="ghost" size="sm" onClick={() => slots.append({ date: date || "", mealType: "lunch", label: "" })}>
            <Plus size={13} /> Add slot
          </Button>
        </div>
        {slots.fields.length === 0 ? (
          <div className="text-[12.5px] text-neutral-500">No meals for this event. Add a slot per meal per day — "Day 1 lunch" — so each can be served exactly once per person.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {slots.fields.map((slot, i) => (
              <div key={slot.id} className="panel grid grid-cols-1 gap-2 p-2.5 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
                <Field error={err.mealSlots?.[i]?.date?.message}>
                  <Input type="date" {...form.register(`mealSlots.${i}.date`)} />
                </Field>
                <Field error={err.mealSlots?.[i]?.mealType?.message}>
                  <NativeSelect {...form.register(`mealSlots.${i}.mealType`)}>
                    {MEAL_TYPES_LIST.map((m) => (
                      <option key={m} value={m}>
                        {m[0]!.toUpperCase() + m.slice(1)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field error={err.mealSlots?.[i]?.label?.message}>
                  <Input placeholder="Day 1 lunch" {...form.register(`mealSlots.${i}.label`)} />
                </Field>
                <Button variant="secondary" size="icon" aria-label="Remove slot" onClick={() => slots.remove(i)}>
                  <X size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export const CoordinatorsFields = ({ form, festId }: { form: Form; festId?: string }) => {
  const list = useFieldArray({ control: form.control, name: "coordinators" });
  const err = form.formState.errors;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Kick>Team and coordinators</Kick>
        <Button variant="ghost" size="sm" onClick={() => list.append({ name: "", phone: "", email: "", role: "", photoUrl: "", linkedinUrl: "", websiteUrl: "" })}>
          <Plus size={13} /> Add
        </Button>
      </div>
      {list.fields.length === 0 ? (
        <div className="text-[12.5px] text-neutral-500">Shown on the event page as “Meet the team”, so participants know who is behind it and who to call. Role, photo and links are optional.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.fields.map((c, i) => (
            <div key={c.id} className="panel grid grid-cols-1 gap-2 p-2.5 sm:grid-cols-[1.2fr_1fr_1.3fr_auto]">
              <Field error={err.coordinators?.[i]?.name?.message}>
                <Input placeholder="Name" {...form.register(`coordinators.${i}.name`)} />
              </Field>
              <Field error={err.coordinators?.[i]?.phone?.message}>
                <Input type="tel" placeholder="+91" {...form.register(`coordinators.${i}.phone`)} />
              </Field>
              <Field error={err.coordinators?.[i]?.email?.message}>
                <Input type="email" placeholder="name@college.edu" {...form.register(`coordinators.${i}.email`)} />
              </Field>
              <Button variant="secondary" size="icon" aria-label="Remove" onClick={() => list.remove(i)}>
                <X size={14} />
              </Button>
              <div className="grid grid-cols-1 gap-2 sm:col-span-4 sm:grid-cols-3">
                <Field error={err.coordinators?.[i]?.role?.message}>
                  <Input placeholder="Role — Event lead" {...form.register(`coordinators.${i}.role`)} />
                </Field>
                <Field error={err.coordinators?.[i]?.linkedinUrl?.message}>
                  <Input type="url" placeholder="LinkedIn URL (https://…)" {...form.register(`coordinators.${i}.linkedinUrl`)} />
                </Field>
                <Field error={err.coordinators?.[i]?.websiteUrl?.message}>
                  <Input type="url" placeholder="Website URL (https://…)" {...form.register(`coordinators.${i}.websiteUrl`)} />
                </Field>
                <ImageUploadField
                  id={`coord-photo-${i}`}
                  label="Photo"
                  kind="eventTeamPhoto"
                  {...(festId ? { ownerId: festId } : {})}
                  aspect="1/1"
                  value={form.watch(`coordinators.${i}.photoUrl`) ?? ""}
                  onChange={(url) => form.setValue(`coordinators.${i}.photoUrl`, url, { shouldDirty: true, shouldValidate: true })}
                  error={err.coordinators?.[i]?.photoUrl?.message}
                  className="sm:col-span-3"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** The 3a right column: the card exactly as a student will see it. */
export const StudentPreview = ({ form, festSlug, festId }: { form: Form; festSlug: string; festId: string }) => {
  const v = form.watch();
  const now = new Date();
  const preview: Event = {
    id: "preview",
    festId,
    slug: v.slug || "preview",
    title: v.title || "Untitled event",
    description: v.description || undefined,
    category: v.category ?? "other",
    visibility: v.visibility ?? "public",
    eventType: v.eventType ?? "solo",
    teamSize: v.eventType === "team" ? { min: Number(v.teamMin) || 1, max: Number(v.teamMax) || 1 } : { min: 1, max: 1 },
    date: v.date || now.toISOString().slice(0, 10),
    startTime: v.startTime || "10:00",
    endTime: v.endTime || undefined,
    venue: v.venue || "Venue",
    capacity: Number(v.capacity) || 0,
    registeredCount: 0,
    registrationOpen: v.registrationOpen ?? true,
    registrationDeadline: v.registrationDeadline || undefined,
    waitlistEnabled: v.waitlistEnabled ?? false,
    entryFee: Number(v.entryFee) || 0,
    paymentEnabled: v.paymentEnabled ?? false,
    posterUrl: v.posterUrl || undefined,
    rulebookUrl: v.rulebookUrl || undefined,
    prizePool: v.prizePool || undefined,
    rules: lines(v.rulesText),
    prizes: lines(v.prizesText),
    coordinators: [],
    gates: lines(v.gatesText),
    mealSlots: (v.mealSlots ?? []) as Event["mealSlots"],
    status: "published",
    liveEnabled: false,
    createdBy: "preview",
    createdAt: now,
    updatedAt: now,
  };

  const checks = [
    { label: "Poster uploaded", done: Boolean(v.posterUrl) },
    { label: "At least one coordinator", done: (v.coordinators?.length ?? 0) > 0 },
    { label: "Rules added", done: lines(v.rulesText).length > 0 },
    { label: "A gate named for scanning", done: lines(v.gatesText).length > 0 },
  ];

  return (
    <div className="flex flex-col gap-3.5">
      <Kick>Student preview</Kick>
      <div className="pointer-events-none">
        <EventCard event={preview} festSlug={festSlug} />
      </div>
      <div className="note">
        <div className="note-title">Before you publish</div>
        <div className="flex flex-col gap-[5px]">
          {checks.map((c) => (
            <div key={c.label} className={c.done ? "text-text" : ""}>
              {c.label} — {c.done ? "done" : "pending"}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
