import type { CertificateDraft, CertificateType } from "../models/certificate";
import { holdsSeat } from "../models/registration";
import type { Registration } from "../models/registration";
import type { Result } from "../models/result";

/**
 * Decides who receives a certificate, and which one.
 *
 * The rules, in the order they are applied:
 *
 *  1. Only `confirmed` registrations count. A cancelled entry earns nothing.
 *  2. Attendance is the gate. Someone who registered but never had their QR
 *     code scanned receives no certificate at all — not even participation.
 *  3. A published result sheet upgrades an attendee from `participation` to
 *     the award their entry placed for.
 *  4. For a team entry, every member who has an account receives their own
 *     certificate, carrying the team name.
 *  5. One certificate per person per event. If somebody appears in more than
 *     one entry, the strongest award wins.
 *
 * This is a pure function: no Firestore, no clock, no randomness. The data
 * layer gathers the inputs, and the Expo app in Phase 2 calls the exact same
 * code. Everything about who deserves what is decided here and nowhere else,
 * which is what makes the policy reviewable and testable in isolation.
 */

/** Strongest first. Used to resolve a person appearing in two entries. */
const AWARD_PRECEDENCE: CertificateType[] = [
  "winner",
  "runner_up",
  "second_runner_up",
  "special_mention",
  "participation",
];

const strongerOf = (a: CertificateType, b: CertificateType): CertificateType =>
  AWARD_PRECEDENCE.indexOf(a) <= AWARD_PRECEDENCE.indexOf(b) ? a : b;

export interface EligibilityInput {
  event: { id: string; title: string; festId: string };
  fest: { id: string; name: string };

  /** Every registration for the event, in any status. */
  registrations: Registration[];

  /** Registration ids that have an attendance record. */
  attendedRegistrationIds: Set<string>;

  /**
   * The event's result sheet, if one exists. Only a `published` sheet grants
   * awards; a draft is treated as though there were no results yet, so
   * everyone who attended still earns participation.
   */
  result: Result | null;

  /**
   * Lowercased email to account id, for teammates who were entered by email
   * before they had signed up. Resolved by the data layer.
   */
  userIdByEmail: Map<string, string>;
}

export interface EligibilityOutcome {
  /** Certificates to issue, one per person. */
  drafts: CertificateDraft[];

  /**
   * Attendees who earned a certificate but have no Plansphere account, so
   * nothing can be filed under "My Certificates" for them. Surfaced in the
   * dashboard rather than silently dropped — otherwise a team of four quietly
   * becomes a team of two at certificate time.
   */
  unmatched: Array<{
    name: string;
    email: string;
    registrationId: string;
    type: CertificateType;
  }>;

  /** Counts for the confirmation screen shown before anything is sent. */
  summary: {
    registrations: number;
    attended: number;
    absent: number;
    byType: Record<CertificateType, number>;
  };
}

export const computeCertificateEligibility = (
  input: EligibilityInput,
): EligibilityOutcome => {
  const { event, fest, registrations, attendedRegistrationIds, result, userIdByEmail } = input;

  // Rule 3: only a published sheet awards anything.
  const awardByRegistration = new Map<string, { type: CertificateType; position: number }>();

  if (result && result.status === "published") {
    for (const entry of result.entries) {
      awardByRegistration.set(entry.registrationId, {
        type: entry.award,
        position: entry.position,
      });
    }
  }

  // A draft team that turned up and was scanned in participated; the state
  // is about whether the roster was complete, not about attendance, and
  // attendance is what a participation certificate attests to.
  const confirmed = registrations.filter((registration) => holdsSeat(registration.status));

  // Rule 2: attendance is the gate.
  const attended = confirmed.filter((registration) =>
    attendedRegistrationIds.has(registration.id),
  );

  const byUser = new Map<string, CertificateDraft>();
  const unmatched: EligibilityOutcome["unmatched"] = [];

  for (const registration of attended) {
    const award = awardByRegistration.get(registration.id);
    const type: CertificateType = award?.type ?? "participation";

    // Rule 4: every member of a team entry earns their own certificate.
    for (const member of registration.members) {
      const email = member.email.trim().toLowerCase();
      const userId = member.userId ?? userIdByEmail.get(email);

      if (!userId) {
        unmatched.push({
          name: member.name,
          email,
          registrationId: registration.id,
          type,
        });
        continue;
      }

      const draft: CertificateDraft = {
        userId,
        eventId: event.id,
        festId: fest.id,
        registrationId: registration.id,
        type,
        recipientName: member.name,
        recipientEmail: email,
        eventTitle: event.title,
        festName: fest.name,
        ...(registration.teamName ? { teamName: registration.teamName } : {}),
        ...(award ? { position: award.position } : {}),
      };

      // Rule 5: strongest award wins if they appear more than once.
      const existing = byUser.get(userId);

      if (!existing) {
        byUser.set(userId, draft);
        continue;
      }

      const winner = strongerOf(existing.type, draft.type);
      if (winner !== existing.type) byUser.set(userId, draft);
    }
  }

  const drafts = [...byUser.values()];

  const byType = AWARD_PRECEDENCE.reduce(
    (counts, type) => ({ ...counts, [type]: 0 }),
    {} as Record<CertificateType, number>,
  );

  for (const draft of drafts) byType[draft.type] += 1;

  return {
    drafts,
    unmatched,
    summary: {
      registrations: confirmed.length,
      attended: attended.length,
      absent: confirmed.length - attended.length,
      byType,
    },
  };
};
