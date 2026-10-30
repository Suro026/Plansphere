import { z } from "zod";
import { idSchema } from "./common";

/**
 * One verification or one download of a certificate — the raw material for
 * Certificate Analytics' time-series charts.
 *
 * Kept as its own append-only log rather than a counter on the certificate
 * document for the reason `attendance` and `foodCollections` already are:
 * a counter can tell you "how many", never "when", and "downloads over
 * time" is a chart, not a number. Written fire-and-forget from the public
 * verify/pdf routes — a failed write here must never fail the page a
 * recruiter is looking at.
 */
export const CERTIFICATE_EVENT_TYPES = ["verify", "download"] as const;
export const certificateEventTypeSchema = z.enum(CERTIFICATE_EVENT_TYPES);
export type CertificateEventType = z.infer<typeof certificateEventTypeSchema>;

export const certificateEventSchema = z.object({
  id: idSchema,
  certificateId: idSchema,
  certificateNumber: z.string(),
  festId: idSchema,
  eventId: idSchema,
  type: certificateEventTypeSchema,
  at: z.coerce.date(),
});

export type CertificateEvent = z.infer<typeof certificateEventSchema>;
