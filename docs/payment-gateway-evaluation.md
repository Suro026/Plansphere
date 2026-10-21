# Plansphere — optional paid registration: payment gateway evaluation

Date: 2026-10-21 · Repo state: commit `21b459a` plus uncommitted performance changes (none touch registration) · Status: **research and planning only — no code, schema, dependency, environment or deployment change was made, and no payment credentials were used.**

How to read this: facts taken from official pages are linked; anything the official pages did not state, or that I could not retrieve, is marked **`CONFIRM WITH PROVIDER`**. Provider pages were read through an automated fetch on 2026-10-21; pricing tables on marketing pages are the weakest evidence (see §3.1). Nothing here is legal, tax or RBI-regulatory advice — those items are flagged for counsel.

---

## 1. Executive summary

- **Today Plansphere has no payment capability.** `entryFee` is a display-only integer (rupees) on an event; the admin form says "Payments are collected outside Plansphere", and the Terms say "Plansphere does not hold your money". A paid flow is a new subsystem, not a toggle.
- **The existing registration engine is a good base** (one Firestore transaction decides seat, capacity, duplicates, team size), but four things in the current code must change before any money moves: an unpaid hold state, admission checks at the gate, the student-side cancellation path, and the notion of "confirmed".
- **Provider evidence:** Cashfree has the most complete public documentation for what Plansphere needs (sandbox, webhook signatures, a marketplace/split product *and* a partner API that onboards organizers as their own merchants, vendor KYC documented). PayU documents marketplace split settlement but is thin on KYC, sandbox and refunds. PhonePe advertises split settlement and a partner program but publishes no sub-merchant onboarding details. **The evidence does not support a confident *commercial* choice yet**: the zero-fee offers have conditions that may exclude a multi-organizer platform (notably Cashfree's offer excludes partner/reseller referrals), and several decisive facts need written confirmation.
- **Recommended ownership model:** organizer-owned merchant accounts (each college/club is its own merchant of record, money settles straight to it, Plansphere takes 0% and never holds funds), onboarded through a provider's approved partner/embedded API where one is confirmed, otherwise with organizer-supplied credentials. Do **not** pool third-party money in one Plansphere merchant account.
- **Most promising provider to prototype against:** Cashfree, *for engineering reasons* — not yet a commercial recommendation.
- **Exact next implementation step:** a provider-independent change to the registration state machine behind a per-fest flag — add a `pending_payment` seat-hold state with an expiry, a server-only payment record, and make the gate scanner reject anything that is not confirmed-and-settled. No gateway call is needed for it, it cannot affect free events, and it fixes a gap that exists today (§2.5).

---

## 2. What Plansphere has today (verified in the code)

### 2.1 Event data and settings
| Concern | Where | What exists |
|---|---|---|
| Event model | `src/core/models/event.ts` | `entryFee` (int, **rupees**, 0 = free, max 1,000,000), `capacity` (0 = unlimited), `registeredCount` (maintained inside the registration transaction), `registrationOpen`, `registrationDeadline`, `waitlistEnabled`, `eventType` solo/team, `teamSize {min,max}`, `status`. Helpers `isRegistrationOpen`, `isEventFull`, `seatsLeft`. |
| Fee UI | `src/components/admin/event-form.tsx` (input + hint "Payments are collected outside Plansphere"), `src/components/event/register-panel.tsx`, `src/components/event/registration-form.tsx` | Fee is shown only; nothing is charged or checked. |
| Fest model | `src/core/models/fest.ts` | `registrationState`, `organizationName`, `organizationType` (college, university, conference, club, company, ngo), `ownerId`, `createdBy`, `eventHead`, `stats.registrations/checkIns`. **No payee, bank, merchant or tax fields anywhere.** |
| Terms | `src/app/terms/page.tsx` §4 | "Where an event has an entry fee it is set and collected by the organizer… Plansphere does not hold your money." Any model in which Plansphere collects money contradicts this text. |

There is no price tier, currency, discount, tax or per-category pricing concept. The pilot (§7) will almost certainly need categories.

### 2.2 Registrations (free individual and team)
- Model: `src/core/models/registration.ts`. Statuses `draft | confirmed | waitlisted | cancelled`; `holdsSeat(status)` = confirmed or draft; `seats` = member count; `ticketCode` (generated at registration for **every** status); team `members[]`, `memberEmails[]`, `joinCode`, invite statuses.
- Create: `POST /api/registrations` (`src/app/api/registrations/route.ts`). One `db.runTransaction` re-reads the event and fest, enforces fest `registrationState`, deadline, capacity (`registered + seats > capacity`), waitlist, duplicate (userId with status in confirmed/waitlisted), teammate clashes, generates `ticketCode`, writes the registration, and increments `events.registeredCount` and `fests.stats.registrations`. Emails and in-app notifications are sent **after** the transaction.
- Team lifecycle: `/api/registrations/join`, `/api/registrations/[id]/team` — a short team is a `draft` that holds seats until teammates accept, then becomes `confirmed`.
- Cancellation and waitlist: `POST /api/registrations/[id]/cancel` (student; frees seats and promotes the earliest waitlisted entry that fits, in the same transaction), `/api/admin/registrations/[id]` (staff promote/cancel), `src/server/waitlist.ts`.
- Wallet passes: `/api/registrations/[id]/wallet/[platform]`; exports: `/api/admin/registrations/export`, `src/core/services/registration-export.ts` (its "payment" column prints the *fee label*, not a payment status).
- Notifications: `src/server/notify.ts`, `src/server/email/templates`, types in `src/core/models/notification.ts` (`registration_confirmed`, `registration_cancelled`, `waitlist_promoted`, …); day-before reminders: `/api/cron/event-reminders`.

### 2.3 Tickets, QR, attendance
- One QR = the registration's `ticketCode`. Attendance document id = registration id (`src/core/models/attendance.ts`); scanning is `src/data/firebase/repositories/attendance-repository.ts` (`resolveTicket`), manual entry is `/api/admin/attendance/manual`. Public ticket check page: `src/app/t/[ticketCode]` (`force-dynamic`).

### 2.4 Permissions and rules
- Roles `student | volunteer | admin | super_admin` (`src/core/permissions.ts`). **Scope is the fest, not the event**: staff carry a `festIds` token claim and `managesFest(festId)` in `firestore.rules` checks it. There is no event-scoped admin role. Fest configuration such as `fest:configureRegistration` is **super-admin only** today; a self-service organizer becomes admin/owner of their fest (`/api/register-event`, `ownerId`, `creatableRoles(..., isFestOwnerOfTarget)`).
- `firestore.rules`: registrations `create`/`delete` are `serverOnly()`; reads are owner, teammate-by-email, or `managesFest`. **Important:** `update` lets the owner set `status` to `cancelled` directly from the client (only `status`, `cancelledAt`, `updatedAt`, only from `confirmed`). The app itself calls the cancel API, but the rule leaves a path that would skip refund logic once registrations are paid.

### 2.5 Gaps that matter for payments (found while reading the code)
1. **The scanner admits anything that is not `cancelled`.** `resolveTicket` and `/api/admin/attendance/manual` reject only `cancelled`; `draft` and `waitlisted` entries — which already receive a `ticketCode` — are scannable. An unpaid entry would be admitted unless this changes. (Existing behaviour for waitlisted/draft entries is worth reviewing independently.)
2. The ticket code is issued before confirmation, so "ticket exists" ≠ "paid".
3. The duplicate check ignores `draft`; a pending-payment state must be included in it.
4. The client-writable cancel rule (above).
5. ~35 places filter on `status === "confirmed"` (analytics, exports, results, admin tables); a new state or a payment sub-record must be threaded through them deliberately.

---

## 3. Provider comparison

### 3.1 Evidence quality
Cashfree's pricing and Easy Split/Partner documentation were retrievable in full. **PhonePe's pricing page could be read only partially** (the fee table by payment method was not recoverable; one fetch returned just the headline). **PayU's pricing page was readable; its docs pages describe split settlement but omit KYC, sandbox and refund details.** Everything not on an official page is `CONFIRM WITH PROVIDER`.

### 3.2 Standard charges, offers, settlement (as published)
| | **Cashfree** | **PhonePe PG** | **PayU** |
|---|---|---|---|
| Source | [pricing](https://www.cashfree.com/payment-gateway-charges/) | [pricing](https://www.phonepe.com/business-solutions/payment-gateway/pricing/) | [payment gateway](https://payu.in/payment-gateway/), [pricing](https://payu.in/pricing/) |
| Headline rate | "Platform fee" **1.95%** and **2.0%** listed against the main modes; the page does not map rate → mode (**CONFIRM**) | "Standard Plan" **1.99%**, "Free*" (T&C apply) | **2%** domestic Visa/Mastercard, netbanking, BNPL, wallets; **3%** Amex, Diners, EMI, international |
| UPI | "as per the applicable law"; no figure | not stated | UPI P2P zero MDR per page; merchant UPI "varies by business category and volume", no figure (**CONFIRM**) |
| Cards | International 2.99% (Visa/MC), 2.95% (Amex); credit-card EMI 2.2%; debit-card EMI 1.5% | not stated by method | see above; debit/RuPay not separated |
| GST | 18% (or prevailing) on platform fees, **not waived** under the offer | not stated (**CONFIRM**) | "18% GST applicable on all transactions" |
| Setup / annual | "ZERO setup fees"; annual maintenance only for premium services (amount not stated) | zero setup, zero annual maintenance, "T&C apply" | no setup, onboarding or annual fees |
| Refund fee | not stated (**CONFIRM**) | not stated (**CONFIRM**) | not stated; "Instant Refunds" within ~5 min (**CONFIRM** fees) |
| Settlement | T+1 by 8 PM IST during the offer; instant settlement on request (extra charge); standard non-offer cycle not stated | not stated (**CONFIRM**) | T+2 standard; same-day / priority settlement by category, may carry a fee |
| Zero-fee offer | **Festive offer**: new merchants who sign up on/after 21 Jul 2026 and complete KYC; **till 31-Mar-27**; zero platform fee on up to **₹20,00,000 cumulative GMV**; domestic only; excludes Amex/Diners/corporate credit cards, EMI, prepaid, Pay Later, e-mandates, international, methods with MDR ≥3%; may be withdrawn if credit cards ≥60% of GMV (checked from ₹1 L GMV); one offer per PAN or bank account; **excludes MCCs 4111, 8244, 8211, 8241, partner/reseller referrals and custom-priced accounts**; GST not waived | "limited period offer" / "zero payment gateway fees during the offer period" — **eligibility, duration, cap and conditions not stated**; PhonePe's [partner page](https://business.phonepe.com/partner-program) says merchants "may get 0% charges for their first three months" (T&C apply); older press reports a 3-month zero-cost offer | none listed |
| Developer docs | [create order](https://www.cashfree.com/docs/api-reference/payments/latest/orders/create-order.md), [refunds](https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create.md), [webhook signature](https://www.cashfree.com/docs/payments/online/webhooks/signature-verification) | [webhooks](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/webhook), [refunds](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/refund) | [API environments](https://docs.payu.in/docs/payu-india-api-environment), [split settlements](https://docs.payu.in/docs/aggregator-or-marketplace-settlement-solution) |
| UPI + cards | Yes (UPI, cards, netbanking, wallets, EMI, pay-later listed) | UPI and cards advertised; per-method detail **CONFIRM** | Cards, netbanking, wallets, BNPL, UPI listed |
| Webhooks | HMAC-SHA256 over `timestamp + raw body`, Base64, header `x-webhook-signature` + `x-webhook-timestamp` (which secret — client secret vs webhook secret — differs between doc pages: **CONFIRM**) | Server callbacks for payment and refund events; auth by HMAC shared secret or Basic-auth SHA-256 hash in the `Authorization` header; docs advise 2xx within seconds and idempotent handling (duplicates possible) | Reverse-hash check on callback plus server-side Verify Payment API recommended by PayU's own checklist |
| Sandbox | Yes: `sandbox.cashfree.com/pg/orders`; partner sandbox `api-sandbox.cashfree.com/partners`; sandbox vendors auto-activate after ~10 min | Test-mode toggle on the Business Dashboard; `api-preprod.phonepe.com/apis/pg-sandbox/...` refund endpoints; how sandbox credentials are issued **CONFIRM** | Test host `test.payu.in`, separate key+salt; **PayU's reference lists "General APIs" and "Refund Transaction" as not supported in test** — conflicts with the environment page (**CONFIRM**) |
| Refund model | `POST /orders/{order_id}/refunds`; refunds on split orders adjust vendor balances proportionally (can be turned off) | Refund API with merchant refund id, amount in paise, ≤ original amount; refund-status endpoint | Refund API; split refunds need a `var8` split-details parameter |
| Onboarding | "Paperless, same-day"; documents list not stated; KYC approval + activation required | Online sign-up + KYC; documents not stated | Fully online: sign up → business details → KYC → activation; documents not stated |

### 3.3 Multi-organizer support (the deciding question)
| | **Cashfree** | **PhonePe PG** | **PayU** |
|---|---|---|---|
| Marketplace/split product | **Easy Split**: platform assigns each vendor an amount per order (max 5 vendors per transaction); vendors settle on their own cycle (T+2 stated; deferred hold up to 45 days); FAQ lists marketplaces and **educational institutes** as use cases; split must be enabled by Cashfree support in test and production; **extra 0.2% per split "in addition to standard PG charges"** (pricing page says 0.20% or 0.25%, unclear which: **CONFIRM**). Sources: [FAQ](https://www.cashfree.com/docs/payments/split/faq.md), [vendor KYC](https://www.cashfree.com/docs/payments/split/vendor/kyc.md) | [Marketplace PG](https://business.phonepe.com/marketplace-payment-gateway) and [split settlements](https://business.phonepe.com/split-settlements): split by amount or % at transaction time, refunds clawed back proportionally from sellers, platform fee goes to platform account, PhonePe "licensed Payment Aggregator… nodal account"; merchant-of-record, settlement timelines, fees **not stated** | **Split Settlements**: platform = "aggregator merchant", sellers = "child merchants"; PayU "takes care of nodal registrations, settlements and regulatory requirements of sub-sellers"; marketplace commission settles after PayU's TDR; optional `aggregatorCharges`. Onboarding by API (`refer_child_merchant` OAuth scope, create-child-merchant API); fees, KYC documents, approval **not stated**. Source: [docs](https://docs.payu.in/docs/aggregator-or-marketplace-settlement-solution), [onboarding](https://docs.payu.in/docs/introduction-split-settlements) |
| Organizer-owned accounts via partner programme | **Embedded Payments / Partners**: platform registers as partner (via Cashfree support), onboards merchants by API or dashboard (create → update → upload KYC docs → embeddable KYC link → status webhook `MERCHANT_ONBOARDING_STATUS`); partner earns commissions on merchants' transactions. PAN-based types include **Trust** and **Society**; educational institutions not mentioned (**CONFIRM** for colleges/universities). Sources: [intro](https://www.cashfree.com/docs/partners/introduction.md), [merchant onboarding](https://www.cashfree.com/docs/partners/embedded/embedded-merchant-onboarding.md) | [Partner programme](https://business.phonepe.com/partner-program): service partners (referral, **0.20%** partner commission) or technology partners; who owns the merchant's PG account and how settlement is routed is **not stated** | Partner integration docs exist (`hosted-checkout-api-partner-integration`) but the page could not be retrieved (404 at fetch time) — **CONFIRM** |
| KYC burden | Vendor/merchant KYC: individuals PAN + one address proof; businesses PAN, CIN, GSTIN (GSTIN when settlements to a PAN exceed ₹20 L in 12 months). Colleges that are trusts/societies may not have a CIN — **CONFIRM** | "built-in KYC/AML pipelines" claimed; documents not stated | not stated |
| Can the platform take 0% commission? | Easy Split: commission is a per-order number the platform sets; zero not addressed (**CONFIRM**). Partner programme: commissions are earned by the partner; whether a partner may waive them is **CONFIRM** | Marketplace: platform fee amount not stated; partner commission 0.20% is the partner's income (**CONFIRM** whether it is added to the merchant's rate) | `aggregatorCharges` optional (so zero appears possible) — **CONFIRM** |
| Does the zero-fee offer apply to a multi-organizer platform? | **Unverified and doubtful**: offer excludes "partner/reseller referrals"; a ₹20 L cap per merchant would be shared if the platform is the merchant; MCC 8220 (colleges) is not in the excluded list but the organizer's registered MCC is unknown — **CONFIRM** | Unknown — offer terms not retrievable | No offer to apply |

**Reading of the evidence.** All three advertise split/marketplace settlement. Only Cashfree publishes enough detail (KYC fields, statuses, sandbox, partner onboarding API, webhook for onboarding status) to design against without a sales conversation. None of the three public pages states that a *platform may omit its own commission* or confirms treatment of *colleges, trusts and societies* — those are the first questions to put to each provider in writing.

### 3.4 Provider-by-provider verdict
- **Cashfree** — best documented; two viable structures (Easy Split marketplace; Embedded Payments with organizer-owned merchants). Promo offer unlikely to carry over to partner-onboarded organizers. Recommended to prototype against and to approach first.
- **PayU** — mature marketplace product with clear aggregator/child-merchant vocabulary and API onboarding; but pricing for split, KYC, sandbox coverage (refunds not testable per its own reference) and approval are undocumented publicly; 2% + 18% GST, T+2, no promos.
- **PhonePe** — attractive headline (1.99%, limited-period zero fee, UPI strength) but least publicly verifiable for sub-merchants and no retrievable offer terms. Worth a sales query; not a basis for an architecture decision.
- Razorpay and others are outside the requested comparison.

---

## 4. Preserving 0% platform commission

**Terminology to keep straight**
- *Platform commission* — money Plansphere keeps. Policy: **0%**.
- *Gateway processing fee* — the provider's MDR/platform fee (+18% GST on it), plus any split/aggregator fee. This is **not** Plansphere's revenue and exists in every model.
- A "convenience fee" or participant surcharge is a third thing and is **out of scope** (see §6.4).

### 4.1 Option A — organizers connect their own gateway accounts
Each college/club is its own merchant of record; money settles to its bank; Plansphere never holds funds.
- *Variants:* **A1** organizer creates their own account and gives Plansphere API credentials; **A2** Plansphere uses the provider's partner/embedded API to create the organizer's merchant account and run KYC (Cashfree Embedded Payments is the only one with a documented API).
- *Commercial:* 0% commission is natural; the gateway fee is the organizer's, charged by the provider to the organizer. New-merchant promos may apply per organizer (A1 yes if they sign up directly; A2 depends on partner exclusions). Matches the Terms as written.
- *Technical:* per-fest payment account config; **secrets management** (A1 means storing many organizers' API secrets — encrypted, outside Firestore plaintext, never logged); webhooks must be verified per merchant secret and routed to the right fest; refunds use the organizer's credentials; onboarding status handling.
- *Operational:* organizer KYC friction (colleges, trusts, societies, clubs without PAN/bank accounts), support load when an organizer's account is suspended or settlement is held; Plansphere cannot fix their account. Disputes and chargebacks are the organizer's.

### 4.2 Option B — Plansphere as an approved marketplace/aggregator-merchant (split settlement)
The platform has one merchant account with split enabled; participants pay it; the provider splits to organizers (vendors/child merchants).
- *Commercial:* possible at 0% commission but Plansphere's account is charged the gateway fee **and** a split fee (Cashfree: +0.2% per split `CONFIRM`); someone must bear it — deducting it from the organizer's share is a design decision that needs provider confirmation. Promos probably don't apply or are exhausted quickly (single ₹20 L cap).
- *Technical:* vendor onboarding API, split computation at order creation, refund claw-backs, hold/deferred settlement logic, reconciliation of vendor balances.
- *Operational / legal:* Plansphere becomes the contracting party for money flows it does not own: it carries vendor-KYC responsibility at the provider's direction, dispute handling, refund-balance exposure, settlement holds, GST invoice questions. Requires Terms and Privacy changes ("Plansphere does not hold your money" no longer accurate in spirit even if funds sit at a licensed aggregator's nodal account). Counsel should confirm Plansphere's own regulatory status in this arrangement.

### 4.3 Option C — one merchant account, Plansphere pays organizers out
**Not recommended.** Collecting third-party funds in a normal merchant account is, at best, outside what these providers' public documents authorise and, at worst, unauthorised payment aggregation; no provider page reviewed explicitly permits it for this use (`CONFIRM WITH PROVIDER` / counsel). It also makes Plansphere hold, reconcile and tax-report other people's money.

### 4.4 Comparison
| | A (organizer-owned) | B (marketplace/split) | C (single account) |
|---|---|---|---|
| Plansphere commission | 0% | 0% possible | 0% possible |
| Who pays gateway fee | Organizer | Platform account unless deliberately passed on (needs confirmation) | Platform |
| Money touches Plansphere | No | Only at the provider's licensed nodal account | **Yes** |
| Merchant of record | Organizer | Provider/platform arrangement (**CONFIRM**) | Plansphere |
| Contradicts current Terms | No | Yes, needs rewrite | Yes |
| Onboarding burden | On organizer | On Plansphere + organizer | On Plansphere |
| Provider support needed | Partner API (A2) or none (A1) | Split enablement | Written permission |
| Verdict | **Recommended** | Fallback if A2 is unavailable | Reject |

**Recommendation.** Option A: organizer-owned accounts. Use A2 (partner/embedded onboarding) if a provider confirms it for colleges/trusts/societies and at zero partner commission to Plansphere; otherwise A1 for the pilot (one organizer, their own account). Keep B as a fallback only after provider and counsel sign-off.

---

## 5. Required product behaviour

1. **Free events unchanged.** The new code path runs only when the event is priced *and* its fest has an active payment account. `entryFee` 0 (or no payment account) → today's `POST /api/registrations` behaviour, byte for byte. A per-fest feature flag defaults off.
2. **Paid events require a verified payment arrangement.** The event form refuses to publish a priced event while the fest's payment account is not `active`. Existing events with `entryFee > 0` keep working as "pay outside Plansphere" until their organizer opts in.
3. **Confirm only after server-side verification.** The browser's return from checkout is never proof of payment (§6.1).
4. **Pending, failed, successful, duplicate, delayed, refunded** are explicit states (§6.2) with defined transitions.
5. **No duplicate charges, duplicate registrations, or overselling:** seats are held in the same transaction that creates the pending registration (the existing pattern), with a TTL (§6.3).
6. **Teams, tickets, QR, attendance, cancellation keep working** (§6.5).
7. **No sensitive card data stored**; only provider ids and masked display fields (§6.4).
8. **Signed, idempotent webhooks** (§6.1).
9. **No convenience fee / surcharge** until provider terms and law are checked (§6.6).

---

## 6. Proposed design

### 6.1 Payment and registration lifecycle
Registration `status` keeps `draft | confirmed | waitlisted | cancelled` and gains **`pending_payment`**. A separate server-written `payments/{paymentId}` record carries the money state (`not_required | created | pending | paid | failed | expired | refund_pending | refunded | partially_refunded | disputed`). Amounts are integer **paise**, currency `INR`, computed **server-side** from event/category data — never from the client.

```
student submits form
  └─ POST /api/registrations  (free event or no payment account → unchanged)
       └─ paid event → ONE transaction:
            re-read event + fest, re-check window/capacity/duplicates (incl. pending_payment)
            create registration { status: pending_payment, holdExpiresAt: now+TTL, NO ticketCode yet }
            create payments/{id} { status: created, amountPaise, orderId = registrationId }
            events.registeredCount += seats   (seats are held)
       └─ after commit: create the provider order (idempotent on orderId), return checkout session
checkout (provider-hosted) ──► student returns to /registered/[id] (shows "payment pending", polls)
provider ──► POST /api/payments/webhook/[provider]
       1. verify signature on the RAW body (+ timestamp window)
       2. insert paymentEvents/{eventId|hash} with create() — if it exists, return 200 (idempotent)
       3. fetch order status from the provider and compare amount, currency, orderId (never trust the body alone)
       4. transaction: if registration still pending_payment (or hold lapsed but seats free) →
            status confirmed, issue ticketCode, payments.paid; else if seats gone → auto-refund + notify
       5. after commit: confirmation email + notification (existing templates)
failure / abandon ──► hold expires (cron, modelled on /api/cron/event-reminders):
            status cancelled, seats released, waitlist promoted
```
- **Delayed payments:** a success webhook can arrive after the hold expired. Rule: re-take seats transactionally if free; otherwise refund automatically and tell the participant. Needs an organizer decision (§8).
- **Duplicate payment** for one registration (second tab, retried checkout): order id = registration id makes order creation idempotent; a second successful payment is recorded and refunded automatically.
- **Waitlist on paid events:** do not charge on waitlisting. On promotion the entry moves to `pending_payment` with a fresh hold and a payment prompt (changes `src/server/waitlist.ts` and the cancel/admin promote paths).
- **Teams:** one payer (the leader) pays for all `seats`, or per-member payment — an organizer decision. A draft team (under minimum) is not charged until complete, to avoid refunds for teams that never form (alternative: charge at creation and refund on dissolution — needs a decision).
- **Cancellation:** server-only for paid registrations; refund amount from the organizer's policy; refund created with an idempotent refund id; `refund_pending → refunded` driven by provider webhook/status. Organizer-initiated event cancellation triggers a bulk refund job. **Close the client-side cancel path** in `firestore.rules` for paid registrations (§2.5).
- **Gate:** the scanner and manual entry must require `status === "confirmed"` and a settled payment (`paid` or `not_required`). Do this first (§9, Phase 1).

### 6.2 Security
- Webhook endpoint is public; authenticity comes only from the signature. Verify the raw bytes (no JSON re-serialisation), enforce a timestamp tolerance, constant-time comparison, rate-limit by source, return 2xx fast and do slow work after.
- Secrets: organizer API secrets (A1) or partner keys (A2) live in a secret manager/KMS, never in Firestore documents, logs or client bundles; rotate on organizer request. Per-provider webhook secrets are separate from API secrets (the Cashfree docs are inconsistent about which — **CONFIRM**).
- Amount integrity: server computes the amount; verifies the provider-reported amount/currency/order id before confirming.
- Card data: use provider-hosted checkout or a provider SDK that keeps PAN/CVV off Plansphere's servers (SAQ-A style scope). Store only `providerPaymentId`, payment method type, masked last-4/brand if returned.
- Firestore rules: `payments` and `paymentEvents` are `serverOnly()` writes; reads limited to the payer and `managesFest`. Add the new status to the owner-cancel rule's exclusion.
- Audit: record payment config changes, refunds, manual overrides via `src/server/audit.ts`.
- New permission (proposed): `fest:configurePayments`, held by the fest owner (`ownerId`) — not by volunteers and not by every admin. Today fest-level configuration is super-admin-only (§2.4), so this is a new decision.

### 6.3 Capacity and idempotency safeguards
- Seat hold inside the creation transaction (existing pattern) with `holdExpiresAt`; cron releases expired holds and promotes the waitlist.
- Provider order id = registration id; refund id = registration id + counter; webhook dedupe key = provider event id (or hash of timestamp + body).
- Duplicate-registration check includes `pending_payment`.
- Out-of-order events (refund before success, success after cancel) are handled by comparing against the stored state rather than assuming order.

### 6.4 Refunds and reconciliation
- States above; partial refunds supported by amount; refund policy fields on the event (windows, percentages) **supplied by the organizer** — none is invented here.
- **Whether the gateway fee is returned on refunds is not stated by any provider page reviewed — `CONFIRM WITH PROVIDER`** and disclose to organizers.
- Reconciliation: nightly job compares `payments` against the provider's order/settlement reports; mismatches (paid-at-provider but not confirmed, confirmed but not paid, refund drift) raise an admin alert and an audit entry. Organizer-facing export: payer, category, amount, provider reference, settlement date.
- Disputes/chargebacks: for Option A they are the organizer's; store the `disputed` state when the provider reports it.

### 6.5 Existing flows to preserve
`/api/registrations/join`, `/team`, wallet passes, `my-pass`, reminders, exports and analytics all key on `status`/`ticketCode`. For paid registrations the ticket code must not exist (or must not admit) before payment; `registration_confirmed` email/notification fires only on the webhook-confirmed transition. A regression suite (existing `tests/unit` and `tests/emulator` registration, team, waitlist, scanner tests) must run unchanged for free events.

### 6.6 What is deliberately not designed here
- **Convenience fee / surcharge:** not proposed. Any pass-through of gateway cost to participants needs provider-term and consumer/RBI/tax review first. Default assumption: the organizer bears the gateway fee, disclosed to them — a deliberate decision, not an assumption.
- GST invoices/receipts, TCS/TDS, refunds under consumer rules: organizer-side obligations; counsel/CA input needed before launch (`CONFIRM`).
- RBI payment-aggregator regulation and how it applies to each model (especially B and C): counsel, and the provider's written position.

---

## 7. HUMAN 2027 pilot — questions for the organizers
(No prices, categories or publication rules are assumed anywhere in this document.)

**Who is paid**
1. Which legal entity receives the money (college, trust, society, university, association, company)? Who is the authorised signatory? Does that entity already have, or can it open, a payment-gateway merchant account (PAN, bank account, KYC documents)?
2. Is there one beneficiary for all fees, or do paper authors, sponsors, or publishers receive separate amounts?
3. Who will do reconciliation and answer participants' payment queries?

**What is charged**
4. The actual registration categories (e.g. author, co-author, student, faculty, industry, attendee, international) and the price of each — and the currency for international participants.
5. Is the fee per person, per paper, or per team? Can one payer cover several co-authors? Can an institution pay for many people at once?
6. Are **paper submission, publication/proceedings, and conference attendance** separate fees, with separate deadlines? Is anything charged before a paper is accepted?
7. Early-bird, deadline, late-fee, discount, sponsorship, complimentary or offline (bank transfer / DD) cases?
8. Must registration be linked to an accepted-paper identifier? (Plansphere has no paper-submission or review feature today; if that is expected, it is a separate scope.)

**Refunds and rules**
9. Refund and cancellation windows by category; paper rejection; withdrawal after acceptance; event postponement/cancellation; visa refusals; duplicate payments.
10. Who bears gateway fees on a refund?
11. Who bears the gateway fee at all — absorbed in the price, absorbed by the organizer, or shown to participants (only if permitted)?

**Volume and timing**
12. Expected number of paying participants and total value (this decides whether zero-fee offers and their caps matter).
13. Target go-live date and registration-open date (provider KYC lead time is unknown — `CONFIRM`).
14. Receipts/invoices required (GST), and by whom.

---

## 8. Unresolved decisions and provider confirmations

**Provider confirmations (all `CONFIRM WITH PROVIDER`, ideally in writing)**
- Will you contract with a multi-organizer platform under (A2) partner/embedded onboarding or (B) split settlement, for colleges, trusts, societies and clubs? What MCC will organizers carry?
- May the platform take **zero** commission? Does the partner commission apply to the merchant's rate?
- Does the new-merchant zero-fee offer apply to merchants onboarded through the platform, and to split/marketplace GMV? (Cashfree's terms exclude partner/reseller referrals.) PhonePe: full offer terms, eligibility, duration, caps. PayU: any offer.
- UPI MDR for merchants; per-method rates; GST treatment; refund fee; whether gateway fees are returned on refunds.
- Settlement timeline for organizer-owned accounts and for split vendors; reserve/hold policies.
- KYC documents accepted for colleges/universities/trusts/societies/clubs without a CIN or GSTIN; typical activation time.
- Sandbox: how to obtain credentials, which flows (refunds, split, partner onboarding) are testable. (PayU's reference says refunds are not testable.)
- Which secret signs webhooks (Cashfree docs differ by page).

**Product / commercial decisions**
- Ownership model (A1 vs A2 vs B) — recommendation: A.
- Who bears gateway fees; whether any surcharge is ever acceptable.
- Hold TTL; behaviour when a payment arrives after the hold lapsed (refund vs honour if seats remain).
- Teams: single payer vs per-member; charge-at-creation vs charge-when-complete.
- Paid waitlist behaviour; refund policy fields; multiple categories/prices per event.
- Terms/Privacy rewrite; who owns the `fest:configurePayments` permission.
- Counsel: regulatory position of each model; GST/tax handling; consumer-refund rules.

---

## 9. Phased implementation plan

**Phase 0 — decisions (no code).** Send the provider questions in §8; collect HUMAN 2027 answers (§7); choose the ownership model; open a Cashfree sandbox account for prototyping; counsel review.

**Phase 1 — provider-independent hardening (first PR; flag off by default).**
1. Gate: scanner (`resolveTicket`) and `/api/admin/attendance/manual` admit only `confirmed` (and, for paid, `paid`). Review current treatment of `draft`/`waitlisted` entries.
2. Add `pending_payment` status + `holdExpiresAt`; include it in `holdsSeat`, the duplicate check, capacity counters, exports, analytics; add the expiry cron.
3. `payments` / `paymentEvents` collections (server-only) + rules; remove the client cancel path for paid registrations.
4. Event/fest payment fields (price in paise, categories, fest payment-account status, refund policy) and the `fest:configurePayments` permission.
5. Unit + emulator tests; the full free-event regression suite must pass unchanged.

**Phase 2 — Cashfree sandbox integration.** Provider interface + Cashfree adapter; create order (idempotent), hosted checkout, return page with polling, signed webhook route, server-side verification, refund API, expiry/late-payment handling, reconciliation job, admin payment views (status, refund, export). Test with sandbox credentials only.

**Phase 3 — HUMAN 2027 pilot.** Organizer's own account (A1) in sandbox, then live with small internal transactions, reconciliation, refund drill, Terms update, organizer runbook.

**Phase 4 — multi-organizer.** A2 partner onboarding (if confirmed) with onboarding-status webhooks; second provider adapter only if justified by the confirmations (PayU or PhonePe).

---

## 10. Recommendation

- **Most promising provider:** Cashfree — best-documented path to organizer-owned accounts (Embedded Payments) with Easy Split as a fallback, a real sandbox, documented signed webhooks and refund API. **This is an engineering preference; the evidence does not yet support a confident commercial choice** because the zero-fee offer's applicability to partner-onboarded organizers is doubtful and unconfirmed for PhonePe/PayU, and no provider has confirmed zero platform commission or college/trust/society onboarding in writing.
- **Ownership model:** organizer-owned merchant accounts; Plansphere 0% commission, never holds funds; gateway fees are the organizer's unless a deliberate, permitted alternative is chosen. Reject the single-account model.
- **Unresolved commercial questions:** §8 — chiefly partner/offer eligibility, zero-commission permission, college KYC acceptance, fee bearer, refund-fee treatment, HUMAN 2027 categories/prices/refund policy.
- **Exact next implementation step:** Phase 1 items 1–2 — make the scanner require `confirmed`, and introduce the `pending_payment` hold state with expiry, behind a per-fest flag, with tests proving free-event behaviour is unchanged.
