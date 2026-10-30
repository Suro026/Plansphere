import { z } from "zod";
import { auditFieldsSchema, idSchema, shortTextSchema } from "./common";

/**
 * In-app notifications. Email is a separate concern handled by `EmailService`;
 * a notification is the record the student sees inside the app, and it is what
 * the Expo app will subscribe to for push in Phase 2.
 */

export const NOTIFICATION_TYPES = [
  "registration_confirmed",
  "registration_cancelled",
  "payment_required",
  "refund_update",
  "payment_account",
  "team_invite",
  "team_update",
  "waitlist_promoted",
  "event_reminder",
  "event_updated",
  "event_cancelled",
  "attendance_recorded",
  "certificate_issued",
  "results_published",
  "announcement",
  "match_starting",
  "tournament_final_started",
  "champion_declared",
] as const;

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z
  .object({
    id: idSchema,
    /** Recipient. Notifications are always addressed to one account. */
    userId: idSchema,

    type: notificationTypeSchema,
    title: shortTextSchema,
    body: z.string().trim().max(1000),

    /** In-app route to open when tapped, e.g. `/my-certificates`. */
    link: z.string().max(500).optional(),

    /** Ids of what the notification refers to, for deep linking. */
    festId: idSchema.optional(),
    eventId: idSchema.optional(),

    read: z.boolean().default(false),
    readAt: z.date().optional(),
  })
  .merge(auditFieldsSchema);

export type Notification = z.infer<typeof notificationSchema>;

export const createNotificationSchema = z.object({
  userId: idSchema,
  type: notificationTypeSchema,
  title: shortTextSchema,
  body: z.string().trim().max(1000),
  link: z.string().max(500).optional(),
  festId: idSchema.optional(),
  eventId: idSchema.optional(),
});

export type CreateNotification = z.infer<typeof createNotificationSchema>;

/** Short labels for the notification centre's type chips. */
export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  registration_confirmed: "Registration",
  registration_cancelled: "Registration",
  payment_required: "Payment",
  refund_update: "Refund",
  payment_account: "Payment account",
  team_invite: "Team",
  team_update: "Team",
  waitlist_promoted: "Waitlist",
  event_reminder: "Reminder",
  event_updated: "Event update",
  event_cancelled: "Event cancelled",
  attendance_recorded: "Check-in",
  certificate_issued: "Certificate",
  results_published: "Results",
  announcement: "Announcement",
  match_starting: "Match starting",
  tournament_final_started: "Final started",
  champion_declared: "Champion declared",
};
