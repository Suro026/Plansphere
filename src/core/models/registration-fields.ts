import { z } from "zod";
import { idSchema, shortTextSchema } from "./common";

/**
 * What a fest asks its students for.
 *
 * Every fest collects a different set of details — one wants a roll number
 * and a department, the next wants a GitHub profile and a resume link, a
 * hackathon wants both. Hard-coding that set means a code change per fest, so
 * the set is data: the super admin marks each field required, optional or
 * hidden, and the registration form is generated from that.
 *
 * Two rules hold the whole thing together:
 *
 *   - the catalogue below is closed. A field the platform does not know about
 *     is a *custom* field, which carries its own label and type. That keeps
 *     the built-in fields mappable onto the student's profile (we can
 *     pre-fill a college from their account) while still allowing anything.
 *   - the same `validateAnswers` runs in the browser for instant feedback and
 *     again on the server for the real decision. The client copy is a
 *     convenience; the server copy is the rule.
 */

/* ───────────── the catalogue ───────────── */

export const FIELD_REQUIREMENTS = ["required", "optional", "hidden"] as const;
export const fieldRequirementSchema = z.enum(FIELD_REQUIREMENTS);
export type FieldRequirement = z.infer<typeof fieldRequirementSchema>;

/**
 * Built-in fields, in the order they are shown. `fullName` and `email` are
 * here for completeness — they come from the signed-in account and cannot be
 * hidden or made optional, which the editor enforces.
 */
export const BUILT_IN_FIELDS = [
  "fullName",
  "email",
  "phone",
  "college",
  "department",
  "year",
  "gender",
  "rollNumber",
  "city",
  "github",
  "linkedin",
  "resume",
] as const;

export type BuiltInField = (typeof BUILT_IN_FIELDS)[number];

/** Fields the account already answers. They are never asked twice. */
export const IDENTITY_FIELDS = ["fullName", "email"] as const satisfies readonly BuiltInField[];

/**
 * "paragraph" is `textarea` under a friendlier name in the builder; "select"
 * is the single-choice control, "multiselect" its multi-value sibling
 * (answers are stored pipe-separated — see `validateAnswers`/`cleanAnswers`).
 */
export const FIELD_TYPES = ["text", "email", "tel", "number", "select", "multiselect", "checkbox", "date", "file", "url", "textarea"] as const;
export const fieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof fieldTypeSchema>;

export interface FieldDefinition {
  label: string;
  type: FieldType;
  placeholder?: string;
  options?: readonly string[];
  /** Which profile field pre-fills it, when the student has one. */
  profileKey?: "name" | "email" | "phone" | "college" | "department" | "year" | "studentId" | "gender" | "city";
  help?: string;
}

export const BUILT_IN_FIELD_DEFINITIONS: Record<BuiltInField, FieldDefinition> = {
  fullName: { label: "Full name", type: "text", profileKey: "name" },
  email: { label: "Email", type: "email", profileKey: "email" },
  phone: { label: "Phone", type: "tel", placeholder: "+91", profileKey: "phone" },
  college: { label: "College", type: "text", profileKey: "college" },
  department: { label: "Department", type: "text", placeholder: "CSE", profileKey: "department" },
  year: { label: "Year of study", type: "select", options: ["1", "2", "3", "4", "5"], profileKey: "year" },
  gender: { label: "Gender", type: "select", options: ["Female", "Male", "Non-binary", "Prefer not to say"], profileKey: "gender" },
  rollNumber: { label: "Roll number", type: "text", profileKey: "studentId" },
  city: { label: "City", type: "text", profileKey: "city" },
  github: { label: "GitHub", type: "url", placeholder: "https://github.com/…" },
  linkedin: { label: "LinkedIn", type: "url", placeholder: "https://linkedin.com/in/…" },
  resume: { label: "Resume", type: "url", placeholder: "https://…", help: "A link — Drive, Notion, a personal site." },
};

/* ───────────── the configuration ───────────── */

/**
 * A custom question. `key` is generated from the label when it is created and
 * then frozen: answers are stored under it, so renaming the label must not
 * orphan the answers already collected.
 */
export const customFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "Lowercase letters, numbers and underscores"),
  label: shortTextSchema,
  type: fieldTypeSchema.default("text"),
  requirement: fieldRequirementSchema.default("optional"),
  options: z.array(shortTextSchema).max(30).optional(),
  placeholder: z.string().trim().max(120).optional(),
  help: z.string().trim().max(300).optional(),
});

export type CustomField = z.infer<typeof customFieldSchema>;

export const registrationFieldsSchema = z.object({
  /** Built-in field → requirement. Anything absent is treated as hidden. */
  builtIn: z.partialRecord(z.enum(BUILT_IN_FIELDS), fieldRequirementSchema).default({}),
  custom: z.array(customFieldSchema).max(20).default([]),
});

export type RegistrationFields = z.infer<typeof registrationFieldsSchema>;

/**
 * What a fest asks for until someone changes it: the identity fields, plus
 * the three details every college has wanted so far. Everything else starts
 * hidden — asking for a resume link to enter a quiz is the kind of thing that
 * makes people abandon a form.
 */
export const defaultRegistrationFields = (): RegistrationFields => ({
  builtIn: {
    fullName: "required",
    email: "required",
    phone: "required",
    college: "required",
    department: "optional",
    year: "optional",
    gender: "hidden",
    rollNumber: "hidden",
    city: "hidden",
    github: "hidden",
    linkedin: "hidden",
    resume: "hidden",
  },
  custom: [],
});

/** A slug for a custom field, from its label. */
export const fieldKeyFor = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "f$1")
    .slice(0, 40) || "field";

/* ───────────── what the form renders ───────────── */

/** One question, resolved from the configuration and ready to draw. */
export interface ResolvedField extends FieldDefinition {
  key: string;
  requirement: Exclude<FieldRequirement, "hidden">;
  custom: boolean;
}

/**
 * The questions to ask, in catalogue order, custom fields last.
 *
 * Identity fields are dropped: the leader's name and email come from the
 * signed-in account, and asking a student to retype them is how a certificate
 * ends up addressed to "asdf".
 *
 * A fest with no configuration asks nothing. That is deliberate and it is not
 * the same as the default set: fests created before this feature existed have
 * no `registrationFields`, and inventing requirements for them would turn
 * every open registration into a validation error the student cannot fix.
 * The defaults are written onto a fest when it is created, and onto the
 * existing ones by `npm run migrate:fests`.
 */
/**
 * An event's own questions layered on the fest's.
 *
 * An event does not replace what the fest asks for — it adds to it. A
 * built-in field the event sets explicitly (required, optional or hidden)
 * overrides the fest's answer for that one field; anything the event leaves
 * unset falls through to the fest. Custom questions from both are kept,
 * keyed by their own `key`, with the event's version winning if the two
 * happen to share one (an event tuning a question the fest also asks).
 *
 * `undefined` for the event half — the common case, since most events ask
 * exactly what their fest asks — is a no-op: the result is just the fest's
 * configuration.
 */
export const mergeRegistrationFields = (
  festFields: RegistrationFields | undefined,
  eventFields: RegistrationFields | undefined,
): RegistrationFields | undefined => {
  if (!eventFields) return festFields;
  if (!festFields) return eventFields;

  const custom = new Map(festFields.custom.map((field) => [field.key, field]));
  for (const field of eventFields.custom) custom.set(field.key, field);

  return {
    builtIn: { ...festFields.builtIn, ...eventFields.builtIn },
    custom: [...custom.values()],
  };
};

export const visibleFields = (config: RegistrationFields | undefined): ResolvedField[] => {
  if (!config) return [];
  const fields = config;
  const out: ResolvedField[] = [];

  for (const key of BUILT_IN_FIELDS) {
    if ((IDENTITY_FIELDS as readonly string[]).includes(key)) continue;
    const requirement = fields.builtIn?.[key] ?? "hidden";
    if (requirement === "hidden") continue;
    out.push({ ...BUILT_IN_FIELD_DEFINITIONS[key], key, requirement, custom: false });
  }

  for (const field of fields.custom ?? []) {
    if (field.requirement === "hidden") continue;
    out.push({
      key: field.key,
      label: field.label,
      type: field.type,
      requirement: field.requirement,
      custom: true,
      ...(field.options ? { options: field.options } : {}),
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.help ? { help: field.help } : {}),
    });
  }

  return out;
};

/* ───────────── validation ───────────── */

export const answersSchema = z.record(z.string().max(40), z.string().max(2000));
export type RegistrationAnswers = z.infer<typeof answersSchema>;

const URL_RE = /^https?:\/\/[^\s]+\.[^\s]{2,}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Deliberately loose: 7–15 digits with the usual separators. Stricter than
// this and a perfectly good number from the wrong country is refused.
const PHONE_RE = /^\+?[0-9][0-9\s()-]{5,18}[0-9]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks the answers against the fest's configuration.
 *
 * Returns a message per offending field rather than the first failure, so the
 * form can mark every one of them at once. Unknown keys are dropped by
 * `cleanAnswers` rather than rejected: a student whose tab was open while the
 * configuration changed should not hit a wall they cannot see.
 */
export const validateAnswers = (
  config: RegistrationFields | undefined,
  answers: RegistrationAnswers,
): Record<string, string> => {
  const errors: Record<string, string> = {};

  for (const field of visibleFields(config)) {
    const value = (answers[field.key] ?? "").trim();

    if (!value) {
      if (field.requirement === "required") errors[field.key] = `${field.label} is required`;
      continue;
    }

    if (field.type === "url" || field.type === "file") {
      if (!URL_RE.test(value)) errors[field.key] = `${field.label} must be a link starting with https://`;
    } else if (field.type === "tel") {
      if (!PHONE_RE.test(value)) errors[field.key] = `${field.label} must be a phone number`;
    } else if (field.type === "email") {
      if (!EMAIL_RE.test(value)) errors[field.key] = `${field.label} must be an email address`;
    } else if (field.type === "number") {
      if (Number.isNaN(Number(value))) errors[field.key] = `${field.label} must be a number`;
    } else if (field.type === "date") {
      if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) errors[field.key] = `${field.label} must be a date`;
    } else if (field.type === "checkbox") {
      if (value !== "true") errors[field.key] = `${field.label} must be ticked`;
    } else if (field.type === "multiselect" && field.options) {
      const chosen = value.split("|").filter(Boolean);
      if (chosen.length === 0 || chosen.some((v) => !field.options!.includes(v))) {
        errors[field.key] = `Choose from the listed options for ${field.label}`;
      }
    } else if (field.options && !field.options.includes(value)) {
      errors[field.key] = `Choose one of the listed options for ${field.label}`;
    }
  }

  return errors;
};

/** Answers with unknown and hidden keys removed, trimmed, blanks dropped. */
export const cleanAnswers = (
  config: RegistrationFields | undefined,
  answers: RegistrationAnswers,
): RegistrationAnswers => {
  const allowed = new Set(visibleFields(config).map((f) => f.key));
  const out: RegistrationAnswers = {};

  for (const [key, value] of Object.entries(answers)) {
    if (!allowed.has(key)) continue;
    const trimmed = String(value ?? "").trim();
    if (trimmed) out[key] = trimmed.slice(0, 2000);
  }

  return out;
};

/** Column headings for a registration export, in the order asked. */
export const answerColumns = (config: RegistrationFields | undefined): { key: string; label: string }[] =>
  visibleFields(config).map((f) => ({ key: f.key, label: f.label }));

/* ───────────── the editor's own schema ───────────── */

/** What the super admin's editor submits. */
export const updateRegistrationFieldsSchema = z.object({
  festId: idSchema,
  fields: registrationFieldsSchema,
});
