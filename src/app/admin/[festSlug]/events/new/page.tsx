"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useRepositories } from "@/components/providers";
import {
  BasicsFields,
  CoordinatorsFields,
  RegistrationFields,
  ScanningFields,
  StudentPreview,
  emptyEvent,
  eventFormSchema,
  toCreateEvent,
  useEventForm,
  type EventFormValues,
} from "@/components/admin/event-form";
import { Button } from "@/components/ui/button";
import { categoryLabel, detectScheduleConflicts, type ScheduleConflict } from "@/core/models/event";
import { useFestEvents } from "@/components/admin/hooks";
import { AlertDialog, AlertDialogContent } from "@/components/ui/overlays";
import { Kick, MetaList, MetaRow } from "@/components/ui/primitives";
import { RepositoryError } from "@/core/models/common";
import { formatCalendarDate, formatTeamSize } from "@/lib/utils";

const STEPS = ["Basics", "Registration", "Review & publish"] as const;
const DRAFT_KEY = "plansphere.event-draft.v1";

/**
 * 3a — Create an event. Three steps, a live student preview, and a draft
 * that survives a closed tab: the form state is mirrored to localStorage on
 * every change ("draft saved 2s ago").
 */
export default function NewEventPage() {
  const { fest, basePath } = useFest();
  const repos = useRepositories();
  const router = useRouter();
  const allEvents = useFestEvents(fest.id);
  const [conflicts, setConflicts] = React.useState<ScheduleConflict[] | null>(null);
  const [pendingStatus, setPendingStatus] = React.useState<"draft" | "published" | null>(null);

  const storageKey = `${DRAFT_KEY}.${fest.id}`;
  const initial = React.useMemo<EventFormValues>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? { ...emptyEvent(fest.startDate), ...(JSON.parse(raw) as Partial<EventFormValues>) } : emptyEvent(fest.startDate);
    } catch {
      return emptyEvent(fest.startDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once
  }, [storageKey]);

  const form = useEventForm(initial);
  const [step, setStep] = React.useState(0);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [submitting, setSubmitting] = React.useState<"draft" | "publish" | null>(null);

  // Mirror to localStorage, debounced.
  const values = form.watch();
  React.useEffect(() => {
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(values));
        setSavedAt(new Date());
      } catch {
        /* storage unavailable */
      }
    }, 800);
    return () => clearTimeout(t);
  }, [values, storageKey]);

  const stepFields: Array<Array<keyof EventFormValues>> = [
    ["title", "slug", "description", "category", "venue", "date", "startTime", "endTime", "posterUrl", "coordinators"],
    ["eventType", "teamMin", "teamMax", "capacity", "registrationDeadline", "entryFee", "mealSlots", "gatesText"],
    [],
  ];

  const next = async () => {
    const ok = await form.trigger(stepFields[step]);
    if (ok) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const submit = async (status: "draft" | "published") => {
    setSubmitting(status === "draft" ? "draft" : "publish");
    form.setValue("status", status);
    const valid = await form.trigger();
    if (!valid) {
      setSubmitting(null);
      // Jump to the first step with an error.
      const errs = Object.keys(form.formState.errors);
      const idx = stepFields.findIndex((fields) => fields.some((f) => errs.includes(f)));
      if (idx >= 0) setStep(idx);
      toast.error("Some fields need fixing");
      return;
    }
    // trigger() has already validated; parse again to get the output type
    // (numbers coerced, empty strings normalised) rather than raw form state.
    const output = eventFormSchema.parse(form.getValues());

    const found = detectScheduleConflicts(
      {
        date: output.date,
        startTime: output.startTime,
        endTime: output.endTime || undefined,
        venue: output.venue,
        coordinators: output.coordinators.map((c) => ({ name: c.name, phone: c.phone || undefined, email: c.email || undefined })),
      },
      allEvents.data ?? [],
    );

    if (found.length > 0) {
      setConflicts(found);
      setPendingStatus(status);
      setSubmitting(null);
      return;
    }

    await createNow(output);
  };

  const createNow = async (output: ReturnType<typeof eventFormSchema.parse>) => {
    try {
      const created = await repos.events.create(toCreateEvent(output, fest.id));
      window.localStorage.removeItem(storageKey);
      toast.success(output.status === "published" ? "Event published" : "Draft saved");
      router.push(`${basePath}/events/${created.slug}/settings`);
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't save the event");
    } finally {
      setSubmitting(null);
      setConflicts(null);
    }
  };

  const v = form.getValues();

  return (
    <AdminPage className="grid gap-10 pb-[38px] pt-7 lg:grid-cols-[1fr_380px]">
      <div>
        <Kick className="mb-2">New event{savedAt ? ` · draft saved ${Math.max(0, Math.round((Date.now() - savedAt.getTime()) / 1000))}s ago` : ""}</Kick>
        <h2 className="mb-[22px] text-[28px]">Create an event</h2>

        <div className="mb-[26px] flex">
          {STEPS.map((label, i) => (
            <button
              key={label}
              type="button"
              onClick={() => i < step && setStep(i)}
              className={`flex-1 pb-2.5 text-left text-[12.5px] ${i ? "pl-3.5" : ""} ${
                i === step
                  ? "text-accent shadow-[inset_0_-2px_0_var(--color-accent)]"
                  : "text-neutral-500 shadow-[inset_0_-1px_0_var(--color-divider)]"
              }`}
            >
              {i + 1} · {label}
            </button>
          ))}
        </div>

        <form onSubmit={(e) => e.preventDefault()} noValidate>
          {step === 0 ? (
            <div className="flex flex-col gap-6">
              <BasicsFields form={form} festId={fest.id} />
              <CoordinatorsFields form={form} festId={fest.id} />
            </div>
          ) : null}
          {step === 1 ? (
            <div className="flex flex-col gap-6">
              <RegistrationFields form={form} festId={fest.id} />
              <ScanningFields form={form} />
            </div>
          ) : null}
          {step === 2 ? (
            <div>
              <Kick className="mb-2.5">Review</Kick>
              <MetaList>
                <MetaRow label="Title">{v.title || "—"}</MetaRow>
                <MetaRow label="Address" mono>
                  /f/{fest.slug}/e/{v.slug || "—"}
                </MetaRow>
                <MetaRow label="Category">{categoryLabel(v.category ?? "other")}</MetaRow>
                <MetaRow label="When">
                  {formatCalendarDate(v.date)} · {v.startTime}
                  {v.endTime ? ` – ${v.endTime}` : ""}
                </MetaRow>
                <MetaRow label="Venue">{v.venue || "—"}</MetaRow>
                <MetaRow label="Entry">{formatTeamSize(v.eventType ?? "solo", { min: Number(v.teamMin) || 1, max: Number(v.teamMax) || 1 })}</MetaRow>
                <MetaRow label="Capacity">{Number(v.capacity) > 0 ? `${v.capacity} seats${v.waitlistEnabled ? " · waitlist on" : ""}` : "Unlimited"}</MetaRow>
                <MetaRow label="Closes">{v.registrationDeadline ? formatCalendarDate(v.registrationDeadline) : "With the event"}</MetaRow>
                <MetaRow label="Fee">{Number(v.entryFee) > 0 ? `₹${v.entryFee}` : "Free"}</MetaRow>
                <MetaRow label="Gates">{(v.gatesText ?? "").split(/\n/).filter(Boolean).join(", ") || "—"}</MetaRow>
                <MetaRow label="Meal slots">{v.mealSlots?.length ? `${v.mealSlots.length}` : "None"}</MetaRow>
              </MetaList>
              <div className="mt-4 text-[12.5px] text-neutral-500">
                Publishing lists the event on the fest page and opens registration. A draft is visible only here.
              </div>
            </div>
          ) : null}
        </form>

        <div className="mt-[26px] flex flex-wrap gap-2">
          {step > 0 ? (
            <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => submit("draft")} loading={submitting === "draft"}>
            Save draft
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next}>
              Continue to {STEPS[step + 1]?.toLowerCase()}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => submit("published")} loading={submitting === "publish"}>
              Publish event
            </Button>
          )}
        </div>
      </div>

      <div className="hidden lg:block">
        <StudentPreview form={form} festSlug={fest.slug} festId={fest.id} />
      </div>

      <AlertDialog open={conflicts !== null} onOpenChange={(o) => !o && (setConflicts(null), setPendingStatus(null))}>
        <AlertDialogContent
          title="This clashes with another event"
          description="It can still be created — this is a heads-up, not a block."
          confirmLabel={pendingStatus === "published" ? "Publish anyway" : "Save anyway"}
          loading={submitting !== null}
          onConfirm={async () => {
            setSubmitting(pendingStatus === "published" ? "publish" : "draft");
            await createNow(eventFormSchema.parse(form.getValues()));
            setPendingStatus(null);
          }}
        >
          <ul className="mt-3 flex flex-col gap-2">
            {(conflicts ?? []).map((c, i) => (
              <li key={i} className="rounded-md bg-bg/40 px-3 py-2 text-[13px]">
                {c.detail}
              </li>
            ))}
          </ul>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPage>
  );
}
