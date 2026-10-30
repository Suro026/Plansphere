import {
  BUILT_IN_FIELD_DEFINITIONS,
  visibleFields,
  type RegistrationAnswers,
  type RegistrationFields,
  type ResolvedField,
} from "../models/registration-fields";

/**
 * The auto-fill engine.
 *
 * A student should type their college once, not once per event. Every fest
 * asks a different set of questions (the super admin decides what), but the
 * questions overlap heavily, so what the student has already answered is
 * remembered on their profile and the next form arrives mostly filled in.
 *
 * Three rules hold it together:
 *
 *   1. It never overwrites. A value the student has typed in this form wins
 *      over the profile, always — including a deliberate blank. Anything else
 *      means a correction gets silently reverted, which is the single most
 *      infuriating thing a form can do.
 *   2. It only fills fields the form is actually asking. A hidden field is
 *      not pre-filled into existence.
 *   3. It is pure. No Firestore, no React, no `window` — which is what lets
 *      the same function run in the browser for the form and on the server
 *      when the answers are folded back into the profile.
 *
 * `remaining()` is the other half of the promise: it answers "what is the
 * student actually being asked this time", so a form whose every question is
 * already known can say so instead of showing a wall of pre-filled boxes.
 */

/* ───────────── the remembered profile ───────────── */

/**
 * What a student's profile remembers between registrations. Deliberately the
 * same names as the built-in fields, except `studentId`, which the catalogue
 * calls `rollNumber` because that is what a college calls it.
 */
export interface ProfileMemory {
  name?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  college?: string | undefined;
  department?: string | undefined;
  year?: number | string | undefined;
  studentId?: string | undefined;
  gender?: string | undefined;
  city?: string | undefined;
}

/** The profile keys the catalogue can read from. */
type MemoryKey = "name" | "email" | "phone" | "college" | "department" | "year" | "studentId" | "gender" | "city";

/**
 * Which built-in field maps onto which profile key.
 *
 * Most are the same word. `rollNumber` → `studentId` and `fullName` → `name`
 * are the two that are not, and they are declared here rather than guessed.
 */
const FIELD_TO_MEMORY: Partial<Record<string, MemoryKey>> = {
  fullName: "name",
  email: "email",
  phone: "phone",
  college: "college",
  department: "department",
  year: "year",
  rollNumber: "studentId",
  gender: "gender",
  city: "city",
};

/** The reverse: which profile key a given field feeds back into. */
const memoryKeyFor = (field: Pick<ResolvedField, "key" | "custom">): MemoryKey | undefined =>
  field.custom ? undefined : FIELD_TO_MEMORY[field.key];

/** Reads the remembered values off a user document, in either shape. */
export const profileMemoryFrom = (user: Record<string, unknown> | null | undefined): ProfileMemory => {
  if (!user) return {};
  const nested = (user.student as Record<string, unknown> | undefined) ?? {};
  const pick = (key: string, legacy?: string): string | undefined => {
    const value = user[key] ?? nested[key] ?? (legacy ? user[legacy] : undefined);
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text ? text : undefined;
  };

  return {
    name: pick("name", "fullName"),
    email: pick("email"),
    phone: pick("phone"),
    college: pick("college"),
    department: pick("department"),
    year: pick("year"),
    studentId: pick("studentId"),
    gender: pick("gender"),
    city: pick("city"),
  };
};

/* ───────────── filling ───────────── */

const text = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  return String(value).trim();
};

export interface AutofillResult {
  /** Every answer: what was already there, plus what the profile knew. */
  answers: RegistrationAnswers;
  /** Field keys this pass filled in — what the form can mark "from your profile". */
  filled: string[];
  /** Fields the student still has to answer themselves. */
  remaining: ResolvedField[];
}

/**
 * Fills a form from the profile without touching anything already entered.
 *
 * `current` is whatever the student has typed so far (empty on first render).
 * A key present in `current` — even as an empty string — is theirs and is left
 * exactly as it is.
 */
export const autofill = (
  fields: readonly ResolvedField[],
  profile: ProfileMemory,
  current: RegistrationAnswers = {},
): AutofillResult => {
  const answers: RegistrationAnswers = { ...current };
  const filled: string[] = [];

  for (const field of fields) {
    // Rule 1: never overwrite. `in` rather than a truthiness check, so a
    // field the student deliberately cleared stays cleared.
    if (field.key in answers) continue;

    const key = memoryKeyFor(field);
    if (!key) continue;

    const remembered = text(profile[key]);
    if (!remembered) continue;

    // A remembered value that is no longer one of the offered choices is not
    // filled in: showing "3" for a year field whose options are now 1–2 would
    // fail validation with no explanation.
    if (field.options && !field.options.includes(remembered)) continue;

    answers[field.key] = remembered;
    filled.push(field.key);
  }

  return {
    answers,
    filled,
    remaining: fields.filter((field) => !text(answers[field.key])),
  };
};

/** The same, starting from a fest's stored configuration. */
export const autofillFor = (
  config: RegistrationFields | undefined,
  profile: ProfileMemory,
  current: RegistrationAnswers = {},
): AutofillResult => autofill(visibleFields(config), profile, current);

/**
 * What the student is actually being asked this time.
 *
 * Only the fields the profile could not answer — the "only newly required
 * fields should be asked again" half of the promise. A form where this is
 * empty can be submitted in one tap.
 */
export const remaining = (
  config: RegistrationFields | undefined,
  profile: ProfileMemory,
  current: RegistrationAnswers = {},
): ResolvedField[] => autofillFor(config, profile, current).remaining;

/* ───────────── remembering ───────────── */

/**
 * What to write back to the profile after a registration.
 *
 * Only built-in fields, only non-empty answers, and only where the profile
 * does not already hold a value — a student correcting their college on one
 * form should not have it silently overwritten by an older answer, and
 * equally one event's answer should not rewrite the profile behind their
 * back. Changes to the profile itself are made on the profile page.
 *
 * `year` is stored as a number because that is what the schema says.
 */
export const profileUpdatesFrom = (
  fields: readonly ResolvedField[],
  answers: RegistrationAnswers,
  profile: ProfileMemory,
): Partial<Record<MemoryKey, string | number>> => {
  const updates: Partial<Record<MemoryKey, string | number>> = {};

  for (const field of fields) {
    const key = memoryKeyFor(field);
    if (!key || key === "email") continue; // the address is the account's, not a form's

    const answer = text(answers[field.key]);
    if (!answer) continue;
    if (text(profile[key])) continue;

    if (key === "year") {
      const year = Number(answer);
      if (Number.isInteger(year) && year >= 1 && year <= 6) updates.year = year;
      continue;
    }

    updates[key] = answer.slice(0, 200);
  }

  return updates;
};

/** Human label for a remembered field, for "we filled this from your profile". */
export const labelForMemory = (key: MemoryKey): string => {
  const field = Object.entries(FIELD_TO_MEMORY).find(([, memory]) => memory === key)?.[0];
  return field ? (BUILT_IN_FIELD_DEFINITIONS[field as keyof typeof BUILT_IN_FIELD_DEFINITIONS]?.label ?? key) : key;
};
