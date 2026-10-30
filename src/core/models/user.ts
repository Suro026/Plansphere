import { z } from "zod";
import { auditFieldsSchema, emailSchema, httpsUrlSchema, idSchema, phoneSchema, shortTextSchema } from "./common";
import { USER_ROLES } from "../permissions";

/**
 * The unified `users` collection — one document shape for every role.
 *
 * Roles, ranks and capabilities live in `core/permissions.ts`; this file is
 * only the data. Re-exported here so existing imports keep working and there
 * is still exactly one definition.
 */
export { USER_ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, hasAtLeast, roleRank, can, canInScope, creatableRoles, homeForRole } from "../permissions";
export type { UserRole, Permission } from "../permissions";

export const userRoleSchema = z.enum(USER_ROLES);

/** Year of study, 1–6 to cover integrated and postgraduate courses. */
export const yearSchema = z.number().int().min(1).max(6);

/**
 * One flat profile for everybody.
 *
 * Students fill in college/department/year; staff usually leave them empty
 * and carry `designation` instead. Keeping them on one level means a query
 * for "everyone at this college" does not have to know which role wrote the
 * document, and the migration from the old nested `student`/`organizer`
 * blocks was a one-time move.
 */
export const userSchema = z
  .object({
    /** Document id, always equal to the Firebase Auth uid. */
    id: idSchema,
    /** The same value as `id`; present because the spec and the API speak in uids. */
    uid: idSchema.optional(),

    email: emailSchema,
    name: shortTextSchema,
    phone: phoneSchema.optional(),

    /** Profile picture, uploaded through /api/uploads or left unset. */
    avatar: httpsUrlSchema.optional(),

    college: shortTextSchema.optional(),
    department: shortTextSchema.optional(),
    year: yearSchema.optional(),
    /** College roll number. Students only. */
    studentId: shortTextSchema.optional(),
    /** Self-described, free text, never required. */
    gender: shortTextSchema.optional(),
    city: shortTextSchema.optional(),
    /** Staff title, e.g. "Cultural secretary". */
    designation: shortTextSchema.optional(),
    /** Human-readable account id for staff — "ADM-2026-K4P7". Students have none. */
    staffCode: z.string().max(20).optional(),
    /** The institution this account speaks for. Staff only. */
    organization: shortTextSchema.optional(),
    /** A couple of lines, shown to the accounts they create. */
    bio: z.string().trim().max(600).optional(),

    /**
     * Mirrors the `role` custom claim on the user's Auth token.
     *
     * The claim is what Firestore rules and the API routes actually trust.
     * This copy exists so the admin screens can list and filter users without
     * a round trip to the Auth API, and it is only ever written by the server.
     */
    role: userRoleSchema,

    /**
     * Fests this account may act on. Empty for students; a super admin
     * ignores it entirely (the platform is their scope).
     */
    festIds: z.array(idSchema).default([]),

    /**
     * Fests on which this account holds an event role (Event Head, admin, coordinator, volunteer). A mirror written only by
     * the server, so the app can tell when the sign-in token has fallen behind a grant or a revocation. The membership
     * documents are the authority; this decides nothing.
     */
    memberOf: z.array(idSchema).default([]),

    emailVerified: z.boolean().default(false),
    /** Set by a super admin to revoke access without deleting history. */
    disabled: z.boolean().default(false),

    /**
     * False until the person has supplied what their role needs: a student
     * their college and phone, staff nothing beyond the invitation. The app
     * routes an incomplete profile to /complete-profile before anything else.
     */
    profileCompleted: z.boolean().default(false),

    /**
     * True for an account created by a super admin or admin with a temporary
     * password. Every privileged action is refused until it is cleared, so a
     * mailed password cannot be used for anything but changing itself.
     */
    mustChangePassword: z.boolean().default(false),

    /** uid of the staff member who created this account; absent for self sign-up. */
    createdBy: idSchema.optional(),
  })
  .merge(auditFieldsSchema)
  .transform((user) => ({
    ...user,
    uid: user.uid ?? user.id,
    /** @deprecated Read `name`. Kept so existing call sites keep working. */
    fullName: user.name,
    /** @deprecated Read `avatar`. */
    photoUrl: user.avatar,
  }));

export type User = z.infer<typeof userSchema>;

/**
 * Documents written before the unified schema kept the name under `fullName`
 * and the student fields under a nested `student` block. Rather than fail to
 * parse them, normalise on read — the migration rewrites them properly, and
 * until it has run (or for a document it missed) the app still works.
 */
export const normalizeUserDoc = (raw: Record<string, unknown>): Record<string, unknown> => {
  const legacyStudent = (raw.student ?? {}) as Record<string, unknown>;
  const legacyOrganizer = (raw.organizer ?? {}) as Record<string, unknown>;
  const role = raw.role === "organizer" ? "volunteer" : raw.role;
  return {
    ...raw,
    role,
    name: raw.name ?? raw.fullName,
    avatar: raw.avatar ?? raw.photoUrl,
    college: raw.college ?? legacyStudent.college,
    department: raw.department ?? legacyStudent.department,
    year: raw.year ?? legacyStudent.year,
    studentId: raw.studentId ?? legacyStudent.studentId,
    designation: raw.designation ?? legacyOrganizer.designation,
    festIds: raw.festIds ?? legacyOrganizer.festIds ?? [],
    profileCompleted: raw.profileCompleted ?? Boolean(raw.name ?? raw.fullName),
    mustChangePassword: raw.mustChangePassword ?? false,
  };
};

/* ───────────── profile completeness ───────────── */

/**
 * What "completed" means, by role. A student cannot be admitted at a gate
 * without a name and a college on their pass; staff are complete the moment
 * they accept their invitation.
 */
export const isProfileComplete = (user: Pick<User, "role" | "name" | "phone" | "college">): boolean => {
  if (!user.name?.trim()) return false;
  if (user.role === "student") return Boolean(user.phone?.trim() && user.college?.trim());
  return true;
};

/** The student's own profile form — also what /complete-profile submits. */
export const studentProfileSchema = z.object({
  name: shortTextSchema,
  phone: phoneSchema,
  college: shortTextSchema,
  studentId: shortTextSchema.optional(),
  department: shortTextSchema.optional(),
  year: yearSchema.optional(),
});

export type StudentProfileInput = z.infer<typeof studentProfileSchema>;

/* ───────────── credentials ───────────── */

export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128)
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/\d/, "Include a number");

export const passwordsMatch = { message: "Passwords do not match", path: ["confirmPassword"] as string[] };

/**
 * What a student supplies at sign-up, as a plain object so a form can extend
 * it before adding the cross-field refinement. No role field exists: a
 * self-registered account is always a student, decided by the server.
 */
export const studentSignUpFields = z.object({
  name: shortTextSchema,
  email: emailSchema,
  phone: phoneSchema,
  college: shortTextSchema,
  studentId: shortTextSchema.optional(),
  department: shortTextSchema.optional(),
  year: yearSchema.optional(),
  password: passwordSchema,
  confirmPassword: z.string(),
});

export const studentSignUpSchema = studentSignUpFields.refine((data) => data.password === data.confirmPassword, passwordsMatch);

export type StudentSignUp = z.infer<typeof studentSignUpSchema>;

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password").max(128),
});

export type SignIn = z.infer<typeof signInSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password").max(128),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, passwordsMatch)
  .refine((data) => data.password !== data.currentPassword, { message: "Choose a password you have not used here before", path: ["password"] });

export type ChangePassword = z.infer<typeof changePasswordSchema>;

/* ───────────── staff creation ───────────── */

/**
 * Payload for the invite-only staff creation route — the single place a role
 * above `student` is granted. A super admin may create any role; an admin may
 * create volunteers for the fests they manage. Nobody self-registers as staff.
 */
export const createStaffSchema = z.object({
  name: shortTextSchema,
  email: emailSchema,
  phone: phoneSchema.optional(),
  designation: shortTextSchema.optional(),
  role: z.enum(["volunteer", "admin", "super_admin"]),
  festIds: z.array(idSchema).default([]),
});

export type CreateStaff = z.infer<typeof createStaffSchema>;

/**
 * The human-readable account code — "ADM-2026-K4P7".
 *
 * It exists because a uid is 28 characters of noise and staff have to read
 * their identifier to someone over a phone, print it on a lanyard, and quote
 * it in a support message. It is *not* a credential: it identifies, it does
 * not authenticate, and it is safe on a badge.
 */
export const STAFF_CODE_PREFIX = { volunteer: "VOL", admin: "ADM", super_admin: "SUP" } as const;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const generateStaffCode = (
  role: keyof typeof STAFF_CODE_PREFIX,
  year: number,
  randomBytes: (size: number) => Uint8Array,
): string => {
  const bytes = randomBytes(4);
  let suffix = "";
  for (let i = 0; i < 4; i += 1) suffix += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  return `${STAFF_CODE_PREFIX[role]}-${year}-${suffix}`;
};

export const staffCodeSchema = z
  .string()
  .regex(/^(VOL|ADM|SUP)-\d{4}-[0-9A-HJ-NP-TV-Z]{4}$/, "Not a valid staff code");

export const updateUserSchema = z.object({
  name: shortTextSchema.optional(),
  phone: phoneSchema.optional(),
  avatar: httpsUrlSchema.optional(),
  college: shortTextSchema.optional(),
  department: shortTextSchema.optional(),
  year: yearSchema.optional(),
  studentId: shortTextSchema.optional(),
  gender: shortTextSchema.optional(),
  city: shortTextSchema.optional(),
  designation: shortTextSchema.optional(),
  organization: shortTextSchema.optional(),
  bio: z.string().trim().max(600).optional(),
});

export type UpdateUser = z.infer<typeof updateUserSchema>;
