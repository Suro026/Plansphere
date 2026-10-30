"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import type { Event } from "@/core/models/event";
import type { Fest } from "@/core/models/fest";
import { emailSchema, shortTextSchema, RepositoryError } from "@/core/models/common";
import { validateRegistration } from "@/core/models/registration";
import { cleanAnswers, mergeRegistrationFields, validateAnswers, visibleFields, type RegistrationAnswers, type ResolvedField } from "@/core/models/registration-fields";
import { autofill, profileMemoryFrom } from "@/core/services/autofill";
import { useAuth, useRepositories } from "@/components/providers";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/overlays";
import { Kick, MetaRow, Tag } from "@/components/ui/primitives";
import { formatTeamSize } from "@/lib/utils";

/**
 * The registration form — 2a's sheet.
 *
 * The leader is always the signed-in student and is filled from their
 * profile; teammates are entered by name and email. Team-size rules come from
 * the event, never from a constant, and the same `validateRegistration` runs
 * here for instant feedback and again on the server for the real decision.
 *
 * What the fest *asks* is not in this file. `visibleFields(fest)` returns the
 * questions the super admin configured and they are rendered below, pre-filled
 * from the student's profile where the two line up. The same `validateAnswers`
 * runs again on the server, which is the copy that decides.
 */

const memberSchema = z.object({
  name: shortTextSchema,
  email: emailSchema,
});

const schema = z.object({
  teamName: z.string().trim().max(200).optional(),
  members: z.array(memberSchema).min(1),
});

type FormValues = z.input<typeof schema>;

export interface RegistrationFormProps {
  event: Event;
  fest: Fest;
  onDone?: () => void;
}

export const RegistrationForm = ({ event, fest, onDone }: RegistrationFormProps) => {
  const { session, profile } = useAuth();
  const repos = useRepositories();
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);

  const isTeam = event.eventType === "team";
  const leader = {
    name: profile?.fullName ?? session?.displayName ?? "",
    email: profile?.email ?? session?.email ?? "",
  };

  // What the event asks, layered on what the fest asks — see
  // `mergeRegistrationFields`. Most events set nothing of their own and this
  // is just the fest's configuration.
  const mergedFields = React.useMemo(
    () => mergeRegistrationFields(fest.registrationFields, event.registrationFields),
    [fest.registrationFields, event.registrationFields],
  );
  const questions = React.useMemo(() => visibleFields(mergedFields), [mergedFields]);

  /**
   * The auto-fill engine, run once on open.
   *
   * Everything the profile already knows arrives filled in; `fresh` is what
   * the student is actually being asked this time, which is what the heading
   * below counts. The engine is the same function the server runs, so a form
   * that looks complete here is complete there.
   */
  const prefilled = React.useMemo(
    () => autofill(questions, profileMemoryFrom(profile as unknown as Record<string, unknown> | null)),
    [questions, profile],
  );
  const known = React.useMemo(() => new Set(prefilled.filled), [prefilled]);
  const fresh = prefilled.remaining;

  const [answers, setAnswers] = React.useState<RegistrationAnswers>(prefilled.answers);

  // The profile can arrive after the first render (it is subscribed live).
  // Re-run the fill then — never overwriting anything already typed, which
  // is the engine's first rule and the reason this is safe to repeat.
  React.useEffect(() => {
    setAnswers((current) => autofill(questions, profileMemoryFrom(profile as unknown as Record<string, unknown> | null), current).answers);
  }, [questions, profile]);
  const [answerErrors, setAnswerErrors] = React.useState<Record<string, string>>({});

  const setAnswer = (key: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setAnswerErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      teamName: "",
      // Start with the leader plus enough blank rows to reach the minimum.
      members: [leader, ...Array.from({ length: Math.max(0, event.teamSize.min - 1) }, () => ({ name: "", email: "" }))],
    },
  });

  const members = useFieldArray({ control: form.control, name: "members" });
  const count = members.fields.length;
  const canAdd = isTeam && count < event.teamSize.max;
  const needMore = isTeam ? Math.max(0, event.teamSize.min - count) : 0;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);

    const problems = validateAnswers(mergedFields, answers);
    if (Object.keys(problems).length > 0) {
      setAnswerErrors(problems);
      setFormError("Some of the fest's questions still need an answer.");
      return;
    }

    const input = {
      eventId: event.id,
      answers: cleanAnswers(mergedFields, answers),
      teamName: isTeam ? values.teamName?.trim() : undefined,
      members: values.members.map((m, i) => ({
        name: m.name.trim(),
        email: m.email.trim().toLowerCase(),
        ...(i === 0 && profile ? { studentId: profile.studentId, college: profile.college } : {}),
      })),
    };

    const check = validateRegistration(input, event);
    if (!check.ok) {
      setFormError(check.message);
      return;
    }

    try {
      const registration = await repos.registrations.create(input);
      toast.success(registration.status === "pending_payment" ? "Seat held — complete your payment" : "You're in");
      onDone?.();
      router.push(`/registered/${registration.id}`);
    } catch (error) {
      const message =
        error instanceof RepositoryError
          ? error.code === "already-exists"
            ? "You already hold an entry for this event. Find it under My events."
            : error.message
          : "Something went wrong. Please try again.";
      setFormError(message);
    }
  });

  const err = form.formState.errors;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col">
      {isTeam ? (
        <Field label="Team name" htmlFor="teamName" error={err.teamName?.message} className="mb-3">
          <Input id="teamName" placeholder="Null Pointers" autoComplete="off" invalid={Boolean(err.teamName)} {...form.register("teamName")} />
        </Field>
      ) : null}

      <Kick className="mb-2">{isTeam ? "Members" : "Registering"}</Kick>

      <div className="flex flex-col gap-[9px]">
        {members.fields.map((field, index) => {
          const isLeader = index === 0;
          const memberErr = err.members?.[index];

          if (isLeader) {
            return (
              <div key={field.id} className="panel flex items-center gap-[9px] p-2.5">
                <Avatar name={leader.name} src={profile?.photoUrl} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px]">{leader.name || "You"}</div>
                  <div className="truncate text-[11px] text-neutral-500">{leader.email}</div>
                </div>
                <Tag tone="outline">{isTeam ? "Leader" : "You"}</Tag>
                <input type="hidden" {...form.register(`members.${index}.name`)} />
                <input type="hidden" {...form.register(`members.${index}.email`)} />
              </div>
            );
          }

          return (
            <div key={field.id} className="panel flex flex-col gap-2 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-500">Teammate {index + 1}</span>
                {count > event.teamSize.min ? (
                  <button type="button" className="btn btn-ghost text-[12px]" onClick={() => members.remove(index)}>
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field error={memberErr?.name?.message}>
                  <Input placeholder="Full name" autoComplete="off" invalid={Boolean(memberErr?.name)} {...form.register(`members.${index}.name`)} />
                </Field>
                <Field error={memberErr?.email?.message}>
                  <Input type="email" inputMode="email" placeholder="name@college.edu" autoComplete="off" invalid={Boolean(memberErr?.email)} {...form.register(`members.${index}.email`)} />
                </Field>
              </div>
            </div>
          );
        })}

        {canAdd ? (
          <button
            type="button"
            className="panel flex items-center gap-2 px-3 py-2.5 text-left text-[13px] text-neutral-500 hover:text-text"
            onClick={() => members.append({ name: "", email: "" })}
          >
            <span className="grid h-6 w-6 place-items-center rounded-sm shadow-[inset_0_0_0_1px_var(--color-divider)]">+</span>
            Add a teammate
          </button>
        ) : null}
      </div>

      {questions.length > 0 ? (
        <>
          <Kick className="mb-2 mt-5">{fest.name} asks</Kick>
          {known.size > 0 ? (
            <p className="mb-2.5 text-[12px] text-neutral-500">
              {fresh.length === 0
                ? `All ${questions.length} filled in from your profile — check them and you're done.`
                : `${known.size} filled in from your profile · ${fresh.length} to answer.`}
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {questions.map((field) => (
              <AnswerField
                key={field.key}
                field={field}
                value={answers[field.key] ?? ""}
                error={answerErrors[field.key]}
                fromProfile={known.has(field.key)}
                onChange={(value) => setAnswer(field.key, value)}
              />
            ))}
          </div>
        </>
      ) : null}

      {isTeam ? (
        <div className="mt-3 text-[12px] text-accent-300">
          {needMore > 0
            ? `This event needs ${event.teamSize.min} members. Register now and your seats are held as a draft — add ${needMore} more by email, or share the join code you get next. The ticket becomes valid for entry once the team is complete.`
            : count < event.teamSize.max
              ? `You can add ${event.teamSize.max - count} more later.`
              : `That's the full team of ${event.teamSize.max}.`}
        </div>
      ) : null}

      {formError ? (
        <div role="alert" className="mt-3 rounded-md px-3 py-2.5 text-[13px] shadow-[inset_0_0_0_1px_var(--color-danger)]">
          {formError}
        </div>
      ) : null}

      <div className="mt-5 flex flex-col gap-2">
        <MetaRow label="Fest pass" className="bg-none pb-2.5 pt-0">
          {fest.name} · signed in
        </MetaRow>
        <MetaRow label="Entry" className="bg-none py-0 pb-2.5">
          {event.entryFee > 0 ? `₹${event.entryFee.toLocaleString("en-IN")}${event.paymentEnabled ? " · paid once per registration" : ""}` : "Free"} · {formatTeamSize(event.eventType, event.teamSize)}
        </MetaRow>
        <Button type="submit" variant="primary" size="lg" block loading={form.formState.isSubmitting}>
          {event.paymentEnabled && event.entryFee > 0 ? "Hold my seat and pay" : needMore > 0 ? "Register and hold our seats" : "Confirm registration"}
        </Button>
      </div>
    </form>
  );
};

/**
 * One configured question. Deliberately uncontrolled by react-hook-form: the
 * field set is data, not a fixed shape, and registering a dynamic schema per
 * fest buys nothing over a plain record plus the shared validator.
 */
const AnswerField = ({
  field,
  value,
  error,
  fromProfile,
  onChange,
}: {
  field: ResolvedField;
  value: string;
  error?: string;
  /** Filled by the auto-fill engine rather than typed here. */
  fromProfile?: boolean;
  onChange: (value: string) => void;
}) => {
  const id = `q-${field.key}`;
  const label = field.requirement === "optional" ? `${field.label} (optional)` : field.label;
  const hint = fromProfile
    ? [field.help, "From your profile — edit if it has changed."].filter(Boolean).join(" ")
    : (field.help ?? (field.type === "file" ? "Paste a link — Drive, a portfolio, wherever it already lives." : undefined));

  // Multi-select answers are one pipe-separated string on the wire (see
  // `cleanAnswers`); the checklist below is the only place that format is
  // ever assembled or taken apart.
  const selected = new Set(value ? value.split("|").filter(Boolean) : []);
  const toggleMulti = (option: string) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange([...next].join("|"));
  };

  return (
    <Field
      label={field.type === "checkbox" ? undefined : label}
      htmlFor={id}
      error={error}
      {...(hint ? { hint } : {})}
      className={field.type === "textarea" || field.type === "multiselect" ? "sm:col-span-2" : undefined}
    >
      {field.type === "select" && field.options ? (
        <NativeSelect id={id} value={value} invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      ) : field.type === "multiselect" && field.options ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px]">{label}</span>
          <div className="flex flex-wrap gap-1.5">
            {field.options.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={selected.has(option)}
                onClick={() => toggleMulti(option)}
                className={selected.has(option) ? "tag tag-accent cursor-pointer" : "tag tag-outline cursor-pointer"}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ) : field.type === "checkbox" ? (
        <label className="flex items-center gap-2 text-[13px]">
          <input
            id={id}
            type="checkbox"
            checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "")}
            className="h-[16px] w-[16px] accent-accent"
          />
          {label}
        </label>
      ) : field.type === "textarea" ? (
        <Textarea id={id} rows={3} value={value} invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
      ) : field.type === "file" ? (
        <Input
          id={id}
          type="url"
          value={value}
          invalid={Boolean(error)}
          placeholder={field.placeholder ?? "https://drive.google.com/…"}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={
            field.type === "number" ? "number"
            : field.type === "url" ? "url"
            : field.type === "email" ? "email"
            : field.type === "tel" ? "tel"
            : field.type === "date" ? "date"
            : "text"
          }
          value={value}
          invalid={Boolean(error)}
          {...(field.placeholder ? { placeholder: field.placeholder } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
};
