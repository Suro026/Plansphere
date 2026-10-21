import { COLLECTIONS, FieldValue, Timestamp, adminDb } from "@/server/firebase-admin";
import { paymentsEnabled } from "./config";
import { expirePendingHolds, reconcilePendingPayments, retryAutoRefunds, sweepCancelledEvents } from "./lifecycle";

/**
 * The scheduled job for paid registration, and the facts about its health.
 *
 * Everything the system needs to recover on its own is here: finish the
 * refunds of cancelled events, retry owed refunds, release or confirm lapsed
 * holds, and re-check payments whose webhook never came. The route that calls
 * it (`/api/cron/payments`) is not scheduled in `vercel.json` — scheduling it
 * is a deployment step (docs/payments-implementation.md).
 *
 * Each step runs inside its own `try`, with a share of the time budget, so a
 * failure or a slow provider in one step cannot stop the others, and every run
 * leaves a heartbeat (`paymentEvents/_housekeeping`) that `/api/health` reads:
 * if the job stops running, that is visible rather than silent.
 */

export const HEARTBEAT_ID = "_housekeeping";

export interface HousekeepingResult {
  events: { events: number; remaining: number } | null;
  refunds: number | null;
  holds: { expired: number; confirmed: number; skipped: number; errors: number } | null;
  reconciled: number | null;
  /** Step name → short, credential-free message, for any step that threw. */
  errors: Record<string, string>;
  ms: number;
}

const safeMessage = (error: unknown): string => (error instanceof Error ? error.message : "unknown error").slice(0, 200);

export const runPaymentsHousekeeping = async (options: { budgetMs?: number } = {}): Promise<HousekeepingResult> => {
  const started = Date.now();
  const deadline = started + (options.budgetMs ?? 240_000);
  const left = () => Math.max(1000, deadline - Date.now());
  const result: HousekeepingResult = { events: null, refunds: null, holds: null, reconciled: null, errors: {}, ms: 0 };

  const step = async <T>(name: string, share: number, run: (budgetMs: number) => Promise<T>): Promise<T | null> => {
    try {
      return await run(Math.floor(left() * share));
    } catch (error) {
      result.errors[name] = safeMessage(error);
      return null;
    }
  };

  // Money owed comes first, then seats, then the slower re-checks.
  result.events = await step("cancelled-events", 0.3, (budgetMs) => sweepCancelledEvents({ budgetMs }));
  result.refunds = await step("refunds", 0.4, (budgetMs) => retryAutoRefunds({ budgetMs }));
  // Releasing holds always runs: a seat must never stay locked because payments were switched off.
  result.holds = await step("holds", 0.6, (budgetMs) => expirePendingHolds({ budgetMs }));
  if (paymentsEnabled()) result.reconciled = await step("reconcile", 1, (budgetMs) => reconcilePendingPayments({ budgetMs }));

  result.ms = Date.now() - started;
  await adminDb()
    .collection(COLLECTIONS.paymentEvents)
    .doc(HEARTBEAT_ID)
    .set(
      {
        kind: "housekeeping",
        lastRunAt: FieldValue.serverTimestamp(),
        lastRunMs: result.ms,
        lastErrors: result.errors,
        lastSummary: { events: result.events, refunds: result.refunds, holds: result.holds, reconciled: result.reconciled },
        runs: FieldValue.increment(1),
      },
      { merge: true },
    )
    .catch(() => undefined);
  return result;
};

/* ───────────── health ───────────── */

export interface PaymentsHealth {
  ok: boolean;
  enabled: boolean;
  lastRunAt: number | null;
  /** Minutes since the job last ran, or null if it never has. */
  lastRunAgeMinutes: number | null;
  /**
   * never_ran — no heartbeat has ever been written (the job is not scheduled, or has never succeeded in starting);
   * stale     — it has run, but not within `JOB_STALE_MINUTES`;
   * running   — it ran recently.
   * Only a problem once payments are enabled, or when something is waiting on it.
   */
  jobStatus: "never_ran" | "stale" | "running";
  /** Steps that threw in the job's last run. */
  lastRunErrors: string[];
  /** Unpaid holds that are past their time and have not been released or confirmed. */
  overdueHolds: number;
  oldestOverdueHoldMinutes: number | null;
  /** Payments with a refund still owed, and how many of those are scheduled in the past. */
  openRefunds: number;
  refundsDue: number;
  stuckRefunds: number;
  /** Cancelled events whose holds/refunds are not all dealt with. */
  eventsWithWorkLeft: number;
  problems: string[];
}

/** A hold or refund older than this with no recent run of the job means nothing is clearing it. */
const STALE_MINUTES = 30;

/**
 * With payments enabled the job is expected to run at least this often. The recommended schedule is every few
 * minutes; a job that has not run for an hour is either unscheduled, being skipped, or failing to start.
 */
export const JOB_STALE_MINUTES = 60;

/**
 * What an operator needs to know that the money side is keeping up. Cheap
 * (aggregate counts and a few small reads); safe to call from the health route.
 */
export const paymentsHealth = async (): Promise<PaymentsHealth> => {
  const db = adminDb();
  const now = Date.now();
  const heartbeat = (await db.collection(COLLECTIONS.paymentEvents).doc(HEARTBEAT_ID).get()).data();
  const lastRunAt = heartbeat?.lastRunAt instanceof Timestamp ? heartbeat.lastRunAt.toMillis() : null;
  const lastRunAgeMinutes = lastRunAt === null ? null : Math.round((now - lastRunAt) / 60_000);

  const [holds, openRefunds, due, stuck, events] = await Promise.all([
    db.collection(COLLECTIONS.registrations).where("status", "==", "pending_payment").limit(500).get(),
    db.collection(COLLECTIONS.payments).where("openRefunds", "==", true).count().get(),
    db.collection(COLLECTIONS.payments).where("nextRefundAt", "<=", Timestamp.fromMillis(now - STALE_MINUTES * 60_000)).count().get(),
    db.collection(COLLECTIONS.payments).where("flags", "array-contains", "refund_stuck").count().get(),
    db.collection(COLLECTIONS.events).where("refundsPending", "==", true).count().get(),
  ]);

  const overdue = holds.docs
    .map((d) => d.data().holdExpiresAt)
    .filter((t): t is Timestamp => t instanceof Timestamp && t.toMillis() < now - 5 * 60_000)
    .map((t) => t.toMillis());
  const oldestOverdueHoldMinutes = overdue.length ? Math.round((now - Math.min(...overdue)) / 60_000) : null;

  const enabled = paymentsEnabled();
  const jobStale = lastRunAgeMinutes === null || lastRunAgeMinutes > STALE_MINUTES;
  const jobStatus: PaymentsHealth["jobStatus"] = lastRunAt === null ? "never_ran" : lastRunAgeMinutes! > JOB_STALE_MINUTES ? "stale" : "running";
  const lastRunErrors = Object.keys((heartbeat?.lastErrors ?? {}) as Record<string, unknown>);
  const problems: string[] = [];
  if (overdue.length > 0 && jobStale) problems.push(`${overdue.length} unpaid hold(s) are past their time and the payments job has not run in ${lastRunAgeMinutes === null ? "its lifetime" : `${lastRunAgeMinutes} minutes`}`);
  if (due.data().count > 0 && jobStale) problems.push(`${due.data().count} refund(s) are overdue for a retry and the payments job is not running`);
  if (stuck.data().count > 0) problems.push(`${stuck.data().count} refund(s) have failed repeatedly and need a person`);
  if (events.data().count > 0 && jobStale) problems.push(`${events.data().count} cancelled event(s) still have refunds to finish and the payments job is not running`);
  if (enabled && jobStatus === "never_ran") problems.push("payments are enabled but the payments job has never run — it is probably not scheduled");
  if (enabled && jobStatus === "stale") problems.push(`the payments job last ran ${lastRunAgeMinutes} minutes ago (expected at least hourly) — it may be unscheduled, skipped or failing to start`);
  if (lastRunErrors.length > 0) problems.push(`the last run of the payments job had errors in: ${lastRunErrors.join(", ")}`);

  return {
    ok: problems.length === 0,
    enabled,
    lastRunAt,
    lastRunAgeMinutes,
    jobStatus,
    lastRunErrors,
    overdueHolds: overdue.length,
    oldestOverdueHoldMinutes,
    openRefunds: openRefunds.data().count,
    refundsDue: due.data().count,
    stuckRefunds: stuck.data().count,
    eventsWithWorkLeft: events.data().count,
    problems,
  };
};
