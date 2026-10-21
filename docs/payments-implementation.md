# Plansphere — optional paid registration: implementation status

Date: 2026-10-21 · Companion to `docs/payment-gateway-evaluation.md` (the research and design this implements).

**Status in one line: the provider-independent foundation is built and tested. No real payment gateway is integrated, nothing here can move real money, and online payment is off everywhere until the steps in "Before activation" are done.** This is deliberately *not* a production-ready payments feature — see "What is not done".

---

## 1. What exists now

| Area | State |
|---|---|
| Free events and free registration | Unchanged. No payment document, no new fields written, works with payments off and with no payment account. Covered by tests. |
| Existing events that show a fee | Unchanged. `entryFee` stays information-only unless an organizer *also* switches on **Collect the entry fee online** (`paymentEnabled`, default `false`, never inferred from the fee). |
| Payment account per fest | Built. Organizer saves their **own** merchant credentials (encrypted, write-only); a platform administrator approves or suspends. |
| Paid registration lifecycle | Built and tested against an in-repo **test provider**: seat hold with expiry, server-computed amount, order creation, signed webhooks, server-side verification, duplicate/late/failed/abandoned handling, refunds, event cancellation, reconciliation. |
| Admission control | Built, and consolidated after the security audit: **one rule** (`src/core/models/admission.ts`) decides who is let in, and every gate uses it — online scanner, offline roster, manual attendance, meals, wallet passes, the public ticket page, the student ticket and (mirrored) `firestore.rules`. Only `confirmed` entries with a verified or not-required payment are admitted; **draft teams**, **waitlisted**, `pending_payment`, cancelled, refunded and unknown states are refused. |
| Real gateway adapter (Cashfree / PhonePe / PayU) | **Not built, deliberately.** `src/server/payments/providers/registry.ts` registers no real provider. |
| Live payments | **Impossible in this build.** Needs a real adapter *and* `PAYMENTS_ENABLED=1` *and* `PAYMENTS_LIVE_ENABLED=1` *and* an approved `live` account. |

## 2. What stays disabled (and why)

- **`PAYMENTS_ENABLED`** unset → no order can be created, no paid event can be published, paid registration is refused with a clear message (never silently made free).
- **`PAYMENTS_LIVE_ENABLED`** unset → a `live`-mode account cannot take orders.
- **Real provider** → none registered. In production the provider list is empty, so even with the flags on, nothing can be charged.
- **Test provider** → registered only when `PAYMENTS_ALLOW_TEST_PROVIDER=1` **and** `NODE_ENV !== "production"`. It cannot exist in a deployed build.
- **Cron** → `/api/cron/payments` exists but is **not** added to `vercel.json` (that is a deployment setting; see "Before activation").

## 3. Data model (all additive)

New server-only collections (Firestore rules deny every client, explicitly):

| Collection | Doc id | Holds |
|---|---|---|
| `paymentAccounts` | festId | provider, mode (`sandbox`/`live`), status (`pending_review`/`active`/`suspended`), non-secret merchant reference |
| `paymentSecrets` | festId | AES-256-GCM ciphertext of the merchant credentials (AAD = festId). Never returned by any API. |
| `payments` | registrationId | amount (paise), currency, order ids, attempt, status, refunds[], flags, captured-vs-expected amounts |
| `paymentEvents` | `<provider>_<eventId>` | webhook ledger (dedupe + audit) |

New optional fields:

- `events.paymentEnabled` (boolean, default false).
- `registrations.status` gains `pending_payment`; `registrations.paymentStatus` (`not_required | pending | failed | paid | expired | cancelled | needs_review | refund_pending | refunded`), `amountPaise`, `holdExpiresAt`. **Absent on every existing and every free registration** — absent is read as "no payment required".

Two seat predicates, on purpose: `holdsSeat` (confirmed/draft — used by analytics and certificates, **unchanged**, so unpaid holds never count as registrations or earn certificates) and the new `occupiesSeat` (adds `pending_payment` — used only for capacity).

## 4. Lifecycle

```
register (paid event)
  └─ transaction: capacity + duplicate checks, amount from the event, payments/<id> created,
     registration = pending_payment, holdExpiresAt = now + PAYMENT_HOLD_MINUTES, counters +seats
POST /api/registrations/[id]/payment
  └─ idempotent createOrder (amount from payments/<id>, never from the request); if the provider
     already shows it paid, confirm instead
provider → POST /api/payments/webhook/<provider>
  └─ signature verified against *that fest's* secret → ledger → fetchOrder (source of truth) →
     applyOrderSnapshot: amount, currency, order↔registration verified in a transaction
        paid, matches        → confirmed (or draft team) · ticket/emails/invites released
        paid, mismatch       → needs_review (never confirmed; staff return the money)
        paid, 2nd order      → duplicate refunded automatically
        paid, hold lapsed    → reinstated if the seat is free, else refunded automatically
        paid, cancelled      → refunded automatically
        failed               → customer may retry on a new order while the hold lasts
hold expires (cron, or on demand when an event looks full)
  └─ provider asked first; paid → confirmed; unpaid → released, next waitlisted person offered a hold
```

Rules worth knowing:

- **Capacity is a hold, not a promise:** unpaid holds count against capacity until they expire; a paid event that looks full heals itself when the next person tries to register.
- **Waitlist:** waitlisted entries are never charged and cannot start a checkout. On promotion (student cancel, hold expiry, or staff) the person gets a *payment hold*, a notification and an email — not a ticket. If the fest can no longer take payment, they stay on the waitlist.
- **Teams:** one charge per registration (a team pays once). The roster is frozen while the seat is unpaid (join-by-code, invite, accept, decline are refused) so a roster change can never confirm an unpaid entry; invitations and the confirmation email go out after payment.
- **Cancellation:** a student cancelling an unpaid hold releases it, no charge. Cancelling a *paid* entry releases the seat and queues a refund **for staff approval** (refund policy is a business decision, see §8); it cannot be done around the API (Firestore rule tightened). Cancelling the *event* releases unpaid holds and refunds every payment in full, automatically.
- **Refunds** are idempotent per refund id at the provider, retried by the cron, and finished by refund webhooks. A refund for a duplicate payment never touches the registration's own payment.
- **No commission, no added fee:** the amount charged is exactly the event's entry fee.

### Admission (single rule)

| status | admitted | | payment status | admitted |
|---|---|---|---|---|
| confirmed | yes | | absent / `not_required` / `paid` | yes |
| draft (team) | **no** — not an entry until confirmed | | pending, failed, expired, cancelled, `needs_review` | no (unpaid) |
| waitlisted | **no** | | `refund_pending`, `refunded` | no (returned) |
| `pending_payment`, cancelled, anything unknown | no | | anything unknown | no |

Waitlisted entries used to be admitted on free and paid events alike (existing behaviour, flagged in the audit as H1); they are now refused everywhere. **Draft teams are not admitted at any gate, on free or paid events** (decided; the registration page always said so, and now the gates agree). A draft shows no QR on the student ticket and reads "Team not complete" at every gate; the moment enough members accept or join with the code, the entry is `confirmed` and admitted like any other. A team that has paid but is still a draft stays inadmissible until it completes. Nothing about invitations, join codes or the confirmation email changed.

### Payments are bound to the merchant account they were made under

Each payment records the provider, mode, credentials version and the **provider-reported** merchant id. Before any provider contact for it (checkout, verification, reconciliation, refund, webhook) the current account must match: same provider and mode, and either the same credentials version or the same merchant (a key rotation). Otherwise the payment is flagged (`account_changed:*`), nothing is sent, an unpaid hold goes to `needs_review`, and staff can release it. Provider or mode cannot be changed while unpaid holds, payments in review or owed refunds exist. A settled payment is never changed by a later provider read: a different order is refunded for exactly what it captured, and a changed read of the original is only flagged.

### Cancelled events, retries and recovery

Cancelling a paid event writes `refundsPending: true` on the event in the same update that cancels it. `handleEventCancelled` then releases unpaid holds and records and executes a full refund for every paid entry (refunds that were waiting for staff become automatic). It is resumable and idempotent and bounded by a time budget; the flag is removed only when nothing is left, so a timeout, crash or provider outage cannot lose refunds. Whatever is left is finished by the payments job, or by staff with `POST /api/admin/events/[id]/refunds`.

`runPaymentsHousekeeping` (called by `GET /api/cron/payments`) runs, each step isolated and time-boxed: cancelled-event sweep → due refunds → hold release → reconciliation; it writes a heartbeat (`paymentEvents/_housekeeping`). A refund the provider cannot take is retried on a growing delay (2 min doubling to 6 h; `nextRefundAt`) and cannot starve others. Retrying is bounded: after 10 failures (or a day of "pending" at the provider) it is flagged `refund_stuck` and taken off the schedule until staff press "Approve refund" or resume the event's refunds; at most 5 provider refund ids are used per refund. Every provider call is time-boxed (20 s) so the step budgets hold. `GET /api/health` has a `payments` check: `jobStatus` (`never_ran` / `stale` / `running` — with payments enabled, never-ran or silent for an hour is reported as probably unscheduled), the last run's failed steps, overdue holds, overdue and stuck refunds, cancelled events with work left. **The job is not scheduled in this repository, so it is not operational: until `vercel.json` is changed (a deployment decision) health will report it as never run once payments are enabled.**

### Who can change where money goes

Saving credentials is limited to the fest's owner or a platform administrator; other admins see status only. Approval is by a *different* platform administrator and must name the exact credentials version and the provider-reported merchant id (stale or mismatched approvals are refused). Ownership transfer suspends the account; deleting a fest deletes its account and credentials; the fest's other admins and the platform are notified of every change.

### Provider adapter contract

`PaymentProviderAdapter` (`src/server/payments/providers/types.ts`) requires, beyond `createOrder`/`fetchOrder`/webhooks/`refund`: `checkoutHosts` (https hostname allow-list for redirects), `verifyCredentials` (answers with the provider's merchant identity; never throws for bad credentials), and `fetchRefund` (refund state read back from the provider). `refund` must be idempotent per refund id. Every adapter is wrapped by `providers/safe.ts`, which scrubs credentials from errors before they reach a log or Sentry and refuses any checkout URL not on the declared hosts. The reusable suite `tests/unit/support/adapter-contract.ts` states these clauses; a real adapter must pass it against its provider's sandbox before registration. No provider was assumed to support any of this — each clause has to be confirmed from that provider's documentation first.

### Credential encryption and rotation

Blobs are `v2 { kid, iv, tag, data }` (AES-256-GCM, fest id and key id as AAD); `v1` blobs from the first version still open. Keys: `PAYMENT_SECRET_KEY` (current) and `PAYMENT_SECRET_KEYS_PREVIOUS` (decrypt-only). Rotation: put the new key in `PAYMENT_SECRET_KEY`, move the old one to `..._PREVIOUS`, deploy, `POST /api/admin/payments/keys` with `{"dryRun":false}` as a platform administrator (dry run is the default and changes nothing), and drop the old key only once the report shows nothing left on it and `undecryptable: []`. A blob no key can open is reported and never deleted.

## 5. Security notes

- Credentials: encrypted with `PAYMENT_SECRET_KEY`, stored only in a collection every client is denied, decrypted only inside webhook/checkout/refund paths, never logged, never returned (the settings API reports only "saved").
- The webhook is public but acts only on a body signed with the secret of the fest the named order belongs to, and even then re-reads the order from the provider. Bad signature → 401 and no state change; unknown order → 200 and dropped (nothing leaks).
- Authorization: new permissions `payment:configure` and `payment:refund` (admin, within their fest), `payment:approve` (super admin only — an admin cannot approve their own account). All new routes check fest scope.
- Firestore rules: the four new collections are explicit `deny`; owner cancel rejects paid entries; attendance/meal creation rejects unpaid entries.
- Test provider and live mode are gated as in §2. Rate limits: `authenticated.checkout`, `public.webhook`.
- Audit: account saved/approved/suspended and refunds are in the audit log (field *names* only, never values).

## 6. Environment variable names (values are never committed)

`PAYMENTS_ENABLED`, `PAYMENTS_LIVE_ENABLED`, `PAYMENTS_ALLOW_TEST_PROVIDER` (development/CI only), `PAYMENT_HOLD_MINUTES`, `PAYMENT_SECRET_KEY` (base64 of 32 random bytes), `PAYMENT_SECRET_KEYS_PREVIOUS` (comma-separated, only during a rotation), and the existing `CRON_SECRET`. Startup validation (`src/server/env.ts`, shown at `/api/health`) reports a half-configured setup; `features.payments` is `off | sandbox | live`.

## 7. Before activation (checklist)

None of this has been done. In order:

1. **Provider decision and written confirmations** (research doc §8): which provider; that each organizer can be its own merchant (KYC, settlement to the organizer) under an approved partner/embedded model; fees; refund and settlement behaviour. Do not proceed on assumed approval.
2. **Write one adapter** (`src/server/payments/providers/<name>.ts`) implementing `PaymentProviderAdapter` (idempotent `createOrder`, `fetchOrder`, `verifyWebhook`/`peekWebhook`, `verifyCredentials`, idempotent `refund`, `fetchRefund`, `checkoutHosts`) and passing `tests/unit/support/adapter-contract.ts` against the provider sandbox, add it to `registry.ts` and to `PAYMENT_PROVIDERS` in `src/core/models/payment.ts`. Run it against the provider's **sandbox only**; add provider-specific tests (signature vectors from the provider's docs). The lifecycle needs no change.
3. **Create the secrets:** generate `PAYMENT_SECRET_KEY`, store it in the deployment's secret store (Vercel env), back it up separately — losing it makes saved credentials unreadable.
4. **Deploy order:** (a) deploy this code with all payment variables unset (behaviour identical to today); (b) deploy `firestore.rules` (`firebase deploy --only firestore:rules`) — the new rules are additive; (c) no index changes are required; (d) set `PAYMENT_SECRET_KEY`, then `PAYMENTS_ENABLED=1` on a **preview/staging** deployment first.
5. **Schedule the cron** by adding to `vercel.json` (**not done** — deliberately left as a deployment step; until it is, `/api/health` reports the payments job as not running once payments are enabled): `{ "path": "/api/cron/payments", "schedule": "*/5 * * * *" }` — a 5-minute cadence needs a Vercel plan that allows it; with a daily cron, expired holds are still released on demand when an event looks full, but lost webhooks and refund retries are slower to heal. `CRON_SECRET` must be set.
6. **Staging end-to-end in the provider's sandbox:** organizer saves sandbox credentials → super admin approves → publish a paid event → pay, fail, abandon, refund, cancel event; confirm the webhook URL shown in the settings page is registered with the provider.
7. **Only then** consider a live account: `PAYMENTS_LIVE_ENABLED=1`, a `live`-mode account approved by a super admin, a first real transaction with a small amount handled by a human who can refund it.

## 8. Decisions still open (not mine to make)

- Provider and the commercial/KYC/settlement model (research doc §8); whether a partner/embedded onboarding agreement exists.
- **Refund policy:** this build refunds in full automatically only when the *organizer* cancels the event or when money arrives that cannot be honoured; a *student* cancellation queues a refund for staff approval. Whether student refunds are allowed, partial, or fee-bearing (and the Terms text, which currently says Plansphere does not hold money) needs a decision and legal review.
- Per-registration vs per-member pricing (built: per registration, no partial refunds when a teammate leaves), ticket categories/prices (not built), GST/invoicing, payee name on receipts, data-retention for payment records, grievance contact. Counsel items, not engineering.
- Paid *draft* teams: a team that pays but never reaches its minimum stays a paid draft; there is no automatic deadline-refund for it.

## 9. Rollback

- **Code:** redeploy the previous build. Registrations created as `pending_payment` would then be unknown to the old code; before rolling back after any paid usage, release holds (`GET /api/cron/payments`) and finish refunds.
- **Data:** every change is additive; free data is untouched. To switch payments off without a deploy: unset `PAYMENTS_ENABLED` — new paid registrations are refused, existing holds are still released by the cron/on demand, and confirmed paid entries remain valid.
- **Per fest:** suspend the fest's payment account (existing paid entries stay valid; no new orders).

## 10. Tests

*Stage 2 (H2, H3, H4):* `tests/emulator/payments-operations.test.ts` — refunds for a cancelled event under provider outage, a cut-short cancellation, idempotence and time budgets; back-off, starvation, isolation, heartbeat and health; owner-only configuration, approval confirmation and four-eyes, notifications, suspend on transfer, cleanup on fest delete.

*Stage 1 hardening (audit findings H1, H5, H7 and parts of H3, H6, M1, M2, M4, M8, L3):* `tests/unit/admission.test.ts`, `tests/unit/payments-hardening.test.ts`, `tests/unit/payment-adapter-contract.test.ts` (+ `support/adapter-contract.ts`), `tests/emulator/admission.test.ts` (rules, manual route, wallet route, public lookup across all 60 status × payment combinations), `tests/emulator/payments-integrity.test.ts` (settled-payment integrity, merchant-account binding, wrong-account refunds, credential checks, refund lookup/idempotency, scrubbed errors, redirect validation, key rotation, unauthorized access).


- Unit (`tests/unit/payments.test.ts`, env, permissions, scanner): payment model, switches, production gating of the test provider, credential encryption, provider signature handling, offline-scanner refusal of unpaid entries.
- Emulator (`tests/emulator/payments.test.ts`, ~58 cases): free event unchanged; paid registration and capacity (incl. concurrency); checkout idempotency and ownership; webhooks (valid, duplicate, bad signature, forged body, unknown order, amount/currency mismatch, failed + retry, duplicate payment); hold expiry (nothing paid, paid but webhook lost, provider down, late payment with and without a free seat, refund retry, cron auth); cancellation and refund approval; teams; waitlist; organizer rules (publish gate, fee/switch lock, event cancellation refunds); account configuration (encryption, no secret in any response/log/audit, approval authority, unauthorized access).
- Rules (`tests/emulator/firestore-rules.test.ts`) and repository tests cover the denied collections, owner-cancel of paid entries, and scanner/meal refusal of unpaid entries.
- **What is not tested:** anything against a real provider (none exists), the browser UI beyond type-checking and the existing component tests, and load behaviour.

## 11. What is not done

- No real gateway adapter or sandbox against a real provider.
- No ticket categories or multiple prices; no partial refunds; no payout/settlement reconciliation against provider reports (only payment-level reconciliation).
- The student checkout page has not been exercised in a browser against a real hosted checkout (the test provider's URL is not a real page); providers that use an in-page SDK instead of a redirect (`sessionId`) are not wired into the UI.
- A device whose offline roster was downloaded before a refund keeps admitting until its next refresh (the roster refresh is the control; documented, not eliminated — audit M7).
- **Open audit findings:** H6 remainder (KMS, decrypt health check), M-items (notably M3, M5, M6, M7, M9, M10) and the Low items; the payments job is implemented but **not scheduled**. H2, H3 and H4 are fixed in code (see `docs/payments-security-audit.md` §0.1). Live payments remain no-go.
- **Draft teams:** decided and implemented — never admitted. Open business question that remains: a team that paid but never completes has no automatic deadline-refund.
- Wallet passes remain disabled platform-wide as before; the new route check only ensures they will not be issued for unpaid entries.
