import { z } from "zod";
import {
  auditFieldsSchema,
  emailSchema,
  idSchema,
  phoneSchema,
  shortTextSchema,
} from "./common";
import { answersSchema } from "./registration-fields";
import { registrationPaymentStatusSchema } from "./payment";
import type { TeamSize } from "./event";

/**
 * Where an entry stands.
 *
 *   pending_payment  a seat held for a paid event until the payment is verified
 *               server-side (or the hold expires). Not a ticket: nothing is
 *               issued, admitted or counted as confirmed until it is paid.
 *   draft       a team that does not yet meet its event's minimum. It holds
 *               its seats — losing them while the last teammate is deciding
 *               would be the worst possible moment — but it is not a
 *               registration yet, and it says so on the pass.
 *   confirmed   a seat, a ticket, a place at the gate
 *   waitlisted  no seat yet; promoted transactionally when one frees up
 *   cancelled   the seat is back
 */
export const REGISTRATION_STATUSES = ["draft", "confirmed", "waitlisted", "cancelled", "pending_payment"] as const;
export const registrationStatusSchema = z.enum(REGISTRATION_STATUSES);
export type RegistrationStatus = z.infer<typeof registrationStatusSchema>;

/**
 * Does this entry occupy a seat?
 *
 * A draft team does, which is the point of the state: the seats are held
 * while the team assembles. Everything that counts capacity has to agree on
 * this, so it is one function rather than a condition repeated five times.
 */
export const holdsSeat = (status: RegistrationStatus): boolean => status === "confirmed" || status === "draft";

/**
 * Does this entry occupy *capacity*? Everything that holds a seat, plus an
 * unpaid hold: those seats are spoken for until the hold expires, so counters
 * and capacity checks must include them. Deliberately separate from
 * `holdsSeat`, which analytics and certificate eligibility use and which must
 * not count an unpaid entry as a registration.
 */
export const occupiesSeat = (status: RegistrationStatus): boolean => holdsSeat(status) || status === "pending_payment";

/** Is this entry live — neither cancelled nor waiting for a seat? */
export const isActiveEntry = (status: RegistrationStatus): boolean => holdsSeat(status);

/**
 * How many members have actually said yes, and whether that is enough.
 *
 * The leader always counts: they registered. A solo entry is complete by
 * definition.
 */
export const acceptedCount = (members: readonly { isLeader?: boolean; inviteStatus?: string }[]): number =>
  members.filter((member) => member.isLeader === true || member.inviteStatus === "accepted").length;

export const teamIsComplete = (
  members: readonly { isLeader?: boolean; inviteStatus?: string }[],
  teamSize: { min: number },
): boolean => acceptedCount(members) >= teamSize.min;

/**
 * A member of a team entry.
 *
 * Only the person who registers is guaranteed to have an account, so `userId`
 * is optional: teammates are frequently entered by name before they have
 * signed up. When a teammate later registers with the same email, the id is
 * backfilled, which is what lets their certificate reach them.
 */
export const INVITE_STATUSES = ["accepted", "pending", "declined"] as const;
export const inviteStatusSchema = z.enum(INVITE_STATUSES);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

export const teamMemberSchema = z.object({
  name: shortTextSchema,
  email: emailSchema,
  phone: phoneSchema.optional(),
  studentId: shortTextSchema.optional(),
  college: shortTextSchema.optional(),
  userId: idSchema.optional(),
  /** The member who created the registration. Exactly one per registration. */
  isLeader: z.boolean().default(false),
  /**
   * Whether the teammate has confirmed they are on this team. The leader is
   * always `accepted`; everyone else starts `pending` and answers from their
   * Teams page. A declined member is removed from the entry, so `declined`
   * is only ever seen in transit. Defaults to `accepted` so entries written
   * before invitations existed remain valid.
   */
  inviteStatus: inviteStatusSchema.default("accepted"),
  // Coerced: these arrive as ISO strings when a server route returns the entry (a teammate's view, a team action).
  invitedAt: z.coerce.date().optional(),
  respondedAt: z.coerce.date().optional(),
});

export type TeamMember = z.infer<typeof teamMemberSchema>;

/**
 * The string encoded into the QR code on a digital ticket.
 *
 * It is a random, unguessable token rather than the document id: ticket codes
 * are photographed and shared, and a predictable one would let anyone forge a
 * ticket for an event they never registered for. The scanner looks the code up
 * rather than trusting anything encoded in it.
 *
 * `PS-` is the current prefix (Plansphere); `FF-` (FestFlow) is accepted too,
 * because every ticket issued before the rename still has to scan — a QR
 * code already printed or saved to a phone cannot be reissued.
 */
export const ticketCodeSchema = z
  .string()
  .regex(/^(?:PS|FF)-[0-9A-HJ-NP-Z]{10}$/, "Not a valid ticket code");

export const registrationSchema = z
  .object({
    id: idSchema,
    eventId: idSchema,
    festId: idSchema,

    /** The account that created the registration; owns the ticket. */
    userId: idSchema,

    type: z.enum(["solo", "team"]),
    teamName: shortTextSchema.optional(),
    members: z.array(teamMemberSchema).min(1).max(50),
    /**
     * Flat copy of `members[].email`, because Firestore cannot query inside an
     * array of objects and "is this person already on a team" has to be a
     * query, not a scan.
     */
    memberEmails: z.array(emailSchema).default([]),
    /** Seats this entry consumes — the member count at registration time. */
    seats: z.number().int().min(1).default(1),

    ticketCode: ticketCodeSchema,
    /**
     * The code a teammate types to join, instead of waiting to be invited by
     * email. Short and readable because it gets read out across a room.
     * Teams only, and it stops working the moment the team is full.
     */
    joinCode: z.string().regex(/^[0-9A-HJ-NP-TV-Z]{6}$/).optional(),
    status: registrationStatusSchema.default("confirmed"),

    /**
     * Payment state. Absent on free entries and on everything created before
     * payments existed, which therefore parse as `not_required`.
     */
    paymentStatus: registrationPaymentStatusSchema.default("not_required"),
    /** What was charged, in paise (server-calculated from the event). */
    amountPaise: z.number().int().min(0).optional(),
    /** While `pending_payment`: when the held seat is released if still unpaid. */
    holdExpiresAt: z.coerce.date().optional(),

    /**
     * Denormalised so the admin registration table and the scanner can render
     * a row without a per-registration lookup of the event and the user.
     * Firestore has no joins; this is the standard trade, and these fields are
     * immutable in practice (an event title change does not retroactively
     * matter on a ticket already issued).
     */
    eventTitle: shortTextSchema,
    userName: shortTextSchema,
    userEmail: emailSchema,

    /**
     * Answers to whatever the fest asks for, keyed by field. The questions
     * live on the fest (`registrationFields`) and can change afterwards, so
     * this is stored as given — a form redesign must not rewrite history, and
     * an export of last year's entries has to still make sense.
     */
    answers: answersSchema.default({}),

    cancelledAt: z.date().optional(),
    /** Set once, the moment a waitlisted entry is promoted to confirmed — the only signal analytics has for waitlist conversion. */
    promotedAt: z.coerce.date().optional(),
  })
  .merge(auditFieldsSchema);

export type Registration = z.infer<typeof registrationSchema>;

/** Every email involved in an entry, used to match teammates to accounts. */
export const memberEmails = (registration: Pick<Registration, "members">): string[] =>
  registration.members.map((member) => member.email.toLowerCase());

/**
 * Ticket code alphabet: Crockford base32 without I, L, O and U, so a code read
 * off a phone screen cannot be mistyped into a different valid code.
 */
const TICKET_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a ticket code from injected randomness.
 *
 * The random source is a parameter because `crypto` is reached differently on
 * web and in React Native, and `src/core` must not depend on either.
 */
/**
 * A six-character team code from the same unambiguous alphabet as the ticket.
 *
 * It is not a secret — it lets someone join a team, which the leader can undo
 * — so six characters is the right trade between "safe to shout" and "tedious
 * to type". A collision is harmless: joining is looked up by code *and*
 * event.
 */
export const generateJoinCode = (randomBytes: (size: number) => Uint8Array): string => {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i += 1) code += TICKET_ALPHABET[(bytes[i] ?? 0) % TICKET_ALPHABET.length];
  return code;
};

export const joinCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-HJ-NP-TV-Z]{6}$/, "A join code is six letters and numbers");

export const generateTicketCode = (randomBytes: (size: number) => Uint8Array): string => {
  const bytes = randomBytes(10);
  let code = "";

  for (let i = 0; i < 10; i += 1) {
    // `noUncheckedIndexedAccess` is on, hence the explicit fallback.
    const byte = bytes[i] ?? 0;
    code += TICKET_ALPHABET[byte % TICKET_ALPHABET.length];
  }

  return `PS-${code}`;
};

const baseCreateRegistration = z.object({
  eventId: idSchema,
  teamName: shortTextSchema.optional(),
  /** Answers to the fest's own questions. Validated against its config. */
  answers: answersSchema.default({}),
  members: z
    .array(teamMemberSchema.omit({ isLeader: true, userId: true, inviteStatus: true, invitedAt: true, respondedAt: true }))
    .min(1)
    .max(50),
});

export type CreateRegistrationInput = z.infer<typeof baseCreateRegistration>;

/**
 * Validates an entry against the event it is for.
 *
 * Team size and duplicate-teammate checks depend on the event, so they cannot
 * live in a static schema. The repository runs this again server-side against
 * the event document rather than trusting whatever the form validated.
 */
export const validateRegistration = (
  // Only the team shape matters here, so the parameter is narrowed to it:
  // callers include the form (which has no answers yet) and the server
  // (which has everything).
  input: { eventId?: string; teamName?: string | undefined; members: readonly { email: string }[] },
  event: { eventType: "solo" | "team"; teamSize: TeamSize },
  options: {
    /**
     * Accept a team that has not reached its minimum yet.
     *
     * The leader registering alone and handing out the join code is a normal
     * way to form a team, so the minimum is not a precondition of creating
     * the entry — it is what moves it from `draft` to `confirmed`. The server
     * passes this; the form uses the default so it can warn early.
     */
    allowIncomplete?: boolean;
  } = {},
): { ok: true } | { ok: false; message: string } => {
  const count = input.members.length;

  if (event.eventType === "solo") {
    if (count !== 1) {
      return { ok: false, message: "This is a solo event; register only yourself" };
    }
  } else {
    if (!options.allowIncomplete && count < event.teamSize.min) {
      return {
        ok: false,
        message: `This event needs at least ${event.teamSize.min} team members`,
      };
    }

    if (count > event.teamSize.max) {
      return {
        ok: false,
        message: `This event allows at most ${event.teamSize.max} team members`,
      };
    }

    if (!input.teamName?.trim()) {
      return { ok: false, message: "Enter a team name" };
    }
  }

  const emails = input.members.map((member) => member.email.trim().toLowerCase());
  const unique = new Set(emails);

  if (unique.size !== emails.length) {
    return { ok: false, message: "The same email appears twice in this team" };
  }

  return { ok: true };
};

export const createRegistrationSchema = baseCreateRegistration;

/* ───────────── team management after registration ───────────── */

export const teamMemberInputSchema = teamMemberSchema.omit({
  isLeader: true,
  userId: true,
  inviteStatus: true,
  invitedAt: true,
  respondedAt: true,
});
export type TeamMemberInput = z.infer<typeof teamMemberInputSchema>;

/**
 * Everything that can happen to a team once it exists.
 *
 * `invite`, `remove` and `rename` are the leader's; `accept` and `decline`
 * belong to the teammate named by email. Each runs as one server transaction
 * against the event so seats never drift from the member list.
 */
export const teamActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), member: teamMemberInputSchema }),
  z.object({ action: z.literal("remove"), email: emailSchema }),
  z.object({ action: z.literal("rename"), teamName: shortTextSchema }),
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("decline") }),
]);
export type TeamAction = z.infer<typeof teamActionSchema>;

/** The member row for an email, if any. */
export const memberFor = (registration: Pick<Registration, "members">, email: string): TeamMember | undefined =>
  registration.members.find((m) => m.email.toLowerCase() === email.toLowerCase());

/** True when the caller is on the entry but did not create it. */
export const isTeammate = (registration: Pick<Registration, "members" | "userId">, userId: string, email: string): boolean =>
  registration.userId !== userId && memberFor(registration, email) !== undefined;

/* ───────────── what a teammate may see ───────────── */

/** A registration as it travels from the server (dates already strings); the shape the viewing helpers below work on. */
export interface RegistrationWire extends Record<string, unknown> {
  userId: string;
  userEmail: string;
  members: Array<{ email: string } & Record<string, unknown>>;
  memberEmails?: string[];
  answers?: unknown;
  joinCode?: unknown;
}

/**
 * `jane.doe@college.edu` → `j___@college.edu`. Still a well-formed address, so it passes the same schema as a real one,
 * but it identifies nobody: enough for a teammate to recognise which row is which, not enough to contact anyone.
 */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at < 1 ? "hidden@hidden.invalid" : `${email[0]}___${email.slice(at)}`;
};

/**
 * An entry as someone who is on the team, but did not make the entry, may see it.
 *
 * The person who registers enters every teammate's email — and, optionally, phone, college and ID — so the organiser
 * can run the event. That is not an invitation for the other teammates to read it. A teammate keeps what they need: the
 * shared ticket and team name, the roster's names and who has accepted, their own full row, and their own address.
 * Everything else about the other members, the leader's address, the leader's registration answers and the join code
 * (which lets its holder add people) is dropped or masked. Applied on the server before anything is sent.
 */
export const teammateView = <T extends RegistrationWire>(registration: T, viewerEmail: string): T => {
  const me = viewerEmail.trim().toLowerCase();
  const { joinCode: _joinCode, ...rest } = registration;
  void _joinCode;
  return {
    ...rest,
    members: registration.members.map((member) =>
      member.email.toLowerCase() === me
        ? member
        : {
            name: member.name,
            email: maskEmail(member.email),
            isLeader: member.isLeader,
            // Only that an account exists ("Joined" rather than "No account yet"): an opaque id, not a way to reach them.
            userId: member.userId,
            inviteStatus: member.inviteStatus,
            invitedAt: member.invitedAt,
            respondedAt: member.respondedAt,
          },
    ),
    userEmail: registration.userEmail.toLowerCase() === me ? registration.userEmail : maskEmail(registration.userEmail),
    // Only the viewer's own address, and only while they are still on the entry (someone who has just declined is not).
    memberEmails: (registration.memberEmails ?? []).some((e) => e.toLowerCase() === me) ? [me] : [],
    answers: {},
  } as unknown as T;
};

/** The entry as `viewer` may see it: in full for the person who made it, as a teammate otherwise. */
export const registrationFor = <T extends RegistrationWire>(registration: T, viewer: { uid: string; email: string }): T => (registration.userId === viewer.uid ? registration : teammateView(registration, viewer.email));

/** The entry still needs answers or people before the event. */
export const teamShortfall = (
  registration: Pick<Registration, "members">,
  teamSize: TeamSize,
): { pending: number; missing: number } => ({
  pending: registration.members.filter((m) => m.inviteStatus === "pending").length,
  missing: Math.max(0, teamSize.min - registration.members.length),
});

/** A student's own view of an entry, joined with its event, for "My Events". */
export interface RegistrationWithEvent {
  registration: Registration;
  event: {
    id: string;
    title: string;
    date: string;
    startTime: string;
    venue: string;
    posterUrl?: string;
  } | null;
  attended: boolean;
}
