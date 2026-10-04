<p align="center">
  <img src="public/logo.png" alt="Plansphere" width="360">
</p>

<p align="center">
  <b>Every fest. One pass.</b><br>
  One platform for a college to run a fest, and one pass for a student to get through it.
</p>

<p align="center">
  <a href="https://github.com/Suro026/FestFlow/actions/workflows/ci.yml"><img src="https://github.com/Suro026/FestFlow/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Next.js-15-black?logo=next.js" alt="Next.js 15">
  <img src="https://img.shields.io/badge/React-19-149eca?logo=react" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Tailwind_CSS-v4-38bdf8?logo=tailwindcss" alt="Tailwind CSS v4">
  <img src="https://img.shields.io/badge/Firebase-Auth%20%2B%20Firestore-ffca28?logo=firebase" alt="Firebase">
</p>

Registrations, QR tickets, gate and meal scanning, results and publicly
verifiable certificates, and live tournaments with sport-specific scoring
and public scoreboards — all from one Next.js app. Web today; an Expo app is
next, sharing the same Firestore collections and the same `src/core`.

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Plansphere landing page" width="49%">
  <img src="docs/screenshots/explore.png" alt="Browsing fests on /explore" width="49%">
</p>

## Contents

- [What it does](#what-it-does)
- [User guide](#user-guide)
  - [Anyone, no account](#anyone-no-account)
  - [Students](#students)
  - [Event Heads — putting your fest on Plansphere](#event-heads--putting-your-fest-on-plansphere)
  - [Super Admins](#super-admins)
  - [Admins](#admins)
  - [Volunteers](#volunteers)
- [Live tournaments](#live-tournaments)
- [Architecture](#architecture)
- [Run locally](#run-locally)
- [Deploy (Vercel)](#deploy-vercel)
- [Security model](#security-model-in-one-paragraph)
- [Further reading](#further-reading)

## What it does

A college registers its fest once and gets, for free: a public event page,
a registration form per event (solo or team), QR tickets, offline-capable
gate and meal scanning, a volunteer roster with shifts, live results,
auto-generated certificates anyone can verify by number, and analytics —
all under one roof, with no spreadsheets stitching it together.

**Stack:** Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS v4
· Firebase Auth + Firestore · Supabase Storage · Zod · React Query.

## User guide

Plansphere has one sign-in for everyone; what you can do depends on your
role. Authority flows one way — from the person who registered the event
down:

```
Event Head  →  Super Admin  →  Admin  →  Volunteer
(the same person, the moment      (created by     (rostered by
 registration finishes)            Super Admin)     Admin, by shift)
```

Students sit outside that chain — they explore, register, and attend.

### Anyone, no account

| Page | What's there |
|---|---|
| [`/explore`](src/app/explore/page.tsx) | Every published fest — search by name, college or venue, filter by city and date |
| `/f/[festSlug]` | A fest's public page: schedule, venue, events |
| `/f/[festSlug]/e/[eventSlug]` | One event's details, and where registration happens |
| [`/live`](src/app/live/page.tsx) | Every fest currently in live-scoring mode, scoreboards updating in real time |
| [`/verify`](src/app/verify/page.tsx) | Look up any certificate by its number — no login, so an employer or another college can check it |
| [`/for-colleges`](src/app/for-colleges/page.tsx) | The pitch, for a college deciding whether to run their fest here |

### Students

1. **Create an account** — [`/create-account`](<src/app/(auth)/create-account/page.tsx>) with a college email, or sign in at [`/sign-in`](<src/app/(auth)/sign-in/page.tsx>).
2. **Find something to register for** — browse [`/explore`](src/app/explore/page.tsx) or open a fest link someone shared, then open an event and register (solo, or as a team — the form adapts to what the event needs).
3. **Carry your pass** — [`/my-pass`](<src/app/(student)/my-pass/page.tsx>) is your QR ticket, working offline; gate and meal staff scan the same code.
4. **Track everything** — [`/my-registrations`](<src/app/(student)/my-registrations/page.tsx>) and [`/my-events`](<src/app/(student)/my-events/page.tsx>) list what you've signed up for; [`/teams`](<src/app/(student)/teams/page.tsx>) manages a team roster if the event needs one.
5. **After it's over** — [`/certificates`](<src/app/(student)/certificates/page.tsx>) has every certificate you've earned, each independently checkable at `/verify` by its number — you can hand the number to anyone without sharing an account.

### Event Heads — putting your fest on Plansphere

There's no approval queue. [`/register-event`](src/app/register-event/page.tsx)
is a three-step form — **Organization → Event → Event Head** — and the moment
you submit it, the fest exists and you're its **Super Admin**. From there
you're in the admin console at `/admin/[festSlug]`, building your team and
opening registrations.

### Super Admins

The Event Head's own role, or anyone they hand it to. On top of everything
an Admin can do:

- **Build the admin team** — [`/admin/[festSlug]/staff`](<src/app/admin/[festSlug]/staff/page.tsx>) creates Admin accounts (and other Super Admins) for this one fest.
- **Fest-wide settings** — [`/admin/[festSlug]/settings`](<src/app/admin/[festSlug]/settings/page.tsx>) and [`/admin/[festSlug]/arenas`](<src/app/admin/[festSlug]/arenas/page.tsx>) (the physical spaces live matches run in).
- **Cross-fest view** — if a Super Admin runs more than one fest, [`/admin/fests`](src/app/admin/fests/page.tsx) lists them all.

### Admins

The day-to-day operators of one fest, from `/admin/[festSlug]`:

| Page | What it's for |
|---|---|
| [`overview`](<src/app/admin/[festSlug]/overview/page.tsx>) | The dashboard: registrations, check-ins, revenue, today's events |
| [`events`](<src/app/admin/[festSlug]/events/page.tsx>) | Create and edit events — rules, capacity, fees, schedule, gates, meal slots |
| [`registrations`](<src/app/admin/[festSlug]/registrations/page.tsx>) | Every registration, exportable, with the audit trail |
| [`volunteers`](<src/app/admin/[festSlug]/volunteers/page.tsx>) | Roster volunteers onto shifts and posts |
| [`gate`](<src/app/admin/[festSlug]/gate/page.tsx>) | Live throughput at the doors — check-ins today, who's scanning where |
| [`certificates`](<src/app/admin/[festSlug]/certificates/page.tsx>) | The four-stage pipeline: results published → eligible participants → generate → email & verification |
| [`analytics`](<src/app/admin/[festSlug]/analytics/page.tsx>) | Registrations, attendance and certificate stats over time |

Publishing results and issuing certificates are one-way, audited actions —
see [Security model](#security-model-in-one-paragraph) for why those go
through the server rather than a direct database write.

### Volunteers

Not a separate account type — an Admin rosters an existing account onto a
shift and post from `/admin/[festSlug]/volunteers`. From then on:

- **[`/volunteer/[festSlug]`](<src/app/volunteer/[festSlug]/page.tsx>)** — your shifts, your post, what's next.
- **[`/scan`](src/app/scan/page.tsx)** — the gate/meal scanner. Works offline: it preloads the event roster, validates locally, queues scans, and syncs when back online. A second scan for the same ticket is refused, never double-counted.
- **[`/volunteer/live`](src/app/volunteer/live/page.tsx)** — if the shift is scoring a live match, this is where a result gets entered (see below).

## Live tournaments

Any event can turn on **live mode** (`Event.liveEnabled`) and become a
scored tournament instead of just an attendance list:

1. A bracket is generated from confirmed entries ([`core/services/bracket.ts`](src/core/services/bracket.ts)).
2. A volunteer scoped to an arena scores matches from [`/volunteer/[festSlug]/live`](<src/app/volunteer/[festSlug]/live/page.tsx>), through a per-sport scoring engine ([`core/services/scoring/*`](src/core/services/scoring)).
3. Anyone can watch it live at [`/live/[eventId]`](<src/app/live/[eventId]/page.tsx>) — no account needed.

Every scoring action goes through the one route in
[`app/api/volunteer/matches/[id]/action/route.ts`](<src/app/api/volunteer/matches/[id]/action/route.ts>);
the shapes are in [`core/models/match.ts`](src/core/models/match.ts).

## Architecture

```
src/
  core/          Platform-agnostic: Zod models, repository interfaces,
                 business rules (certificate eligibility, registration checks).
                 No imports from next, react or firebase — reused by Expo as-is.
  data/          Firestore implementations of the repositories + the auth service.
                 The only code that knows Firebase exists.
  server/        Admin SDK, route authorisation, email service. Server only.
  app/           Routes. Public pages render on the server through the same
                 repositories; privileged writes go through app/api.
  components/    UI. The "Nocturne" design system lives in app/globals.css.
firestore.rules  The real access-control boundary. Roles come from Auth custom
                 claims; every collection is denied unless opened deliberately.
```

## Run locally

```bash
npm ci
cp .env.example .env.local        # then fill in the Firebase web config
npm run dev                       # http://localhost:3000
```

Useful scripts:

| Script | What it does |
|---|---|
| `npm run verify:admin` | Checks `FIREBASE_SERVICE_ACCOUNT` parses and can reach Auth + Firestore |
| `npm run grant-super-admin -- you@college.edu` | Seeds the first super admin (staff accounts are invite-only) |
| `npm run firebase:deploy` | Deploys `firestore.rules` and indexes via the service account — no `firebase login` needed |
| `npm audit` | Dependency advisories; `package.json` `overrides` pin `uuid`/`postcss` to patched lines inside `firebase-admin`/`next` (see `docs/SECURITY-ENV.md`) |
| `npm run scan:secrets` | Fails on any secret-shaped string in tracked files (also a CI step); `-- --history` scans every commit. See `docs/SECURITY-ENV.md` |
| `npm run verify:infra` | Confirms the composite indexes are live and the Supabase Storage buckets exist and are reachable with the service role key; prints one-click console links for anything missing |
| `npm test` | Unit and component tests (Vitest + Testing Library, jsdom) |
| `npm run test:emulator` | Rules, repository and API-transaction tests against the Firebase Auth + Firestore emulators (needs Java 21); Supabase Storage is faked in-memory (see `tests/emulator/uploads-api.test.ts`) |
| `npm run build` | Production build; also what Vercel runs |

CI (`.github/workflows/ci.yml`) runs typecheck → lint → unit tests → emulator
tests → `next build` on every pull request and push to `main`. Make the
`ci` check required in GitHub → Settings → Branches → `main` so nothing
merges red.

## Deploy (Vercel)

The repository root is the Next.js project. Vercel detects Next.js from
`package.json`; `vercel.json` pins it in case the project was previously
configured for another framework.

**Project settings**

| Setting | Value |
|---|---|
| Framework Preset | Next.js |
| Root Directory | `./` (repository root) |
| Build Command | `next build` (default) |
| Output Directory | *leave default* — **not** `dist` |
| Node.js Version | 20.x or later |

**Environment variables** (Project → Settings → Environment Variables, for
Production *and* Preview). Copy the names from `.env.example`.

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Public web config — Firebase console → Project settings → Your apps |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | optional |
| `NEXT_PUBLIC_APP_URL` | `https://plansphere.in` — used in emailed links |
| `FIREBASE_SERVICE_ACCOUNT` | **Secret.** Base64 of the service-account JSON. Bypasses all rules; never `NEXT_PUBLIC_` |
| `SUPABASE_URL` | Project URL — Supabase dashboard → Project settings → API. File storage only; Auth and the database stay on Firebase |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret.** Bypasses every storage policy; never `NEXT_PUBLIC_`. Uploads degrade to "paste a URL instead" without it |
| `SUPABASE_ANON_KEY` | Not currently used server-side; kept for parity with the dashboard's other key |
| `EMAIL_PROVIDER` | `resend` in production; `console` logs instead of sending (every send is still recorded in `emailLog`) |
| `RESEND_API_KEY` | **Secret.** From resend.com → API Keys, after verifying the `plansphere.in` domain (DKIM + SPF + DMARC records) |
| `EMAIL_FROM` | Defaults to `Plansphere <noreply@plansphere.in>` |
| `CRON_SECRET` | **Secret.** Any long random string; Vercel Cron presents it to `/api/cron/event-reminders` (daily 09:00 IST) |
| `NEXT_PUBLIC_SENTRY_DSN` | Enables Sentry (browser + server + edge). `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` additionally upload source maps at build |
| `NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY` | Enables Firebase App Check on the client; `APP_CHECK_ENFORCE=true` makes the API refuse calls without a valid token |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Shared rate-limit store; without them limits are per serverless instance |
| `RATE_LIMIT_OVERRIDES` | JSON per-bucket overrides for the rate-limit policy (`{"auth.login":{"limit":10}}`); `RATE_LIMIT_DISABLED=1` switches limiting off in an incident |

`GET /api/health` (JSON) and `/admin/health` (super admins) report every check
above, plus environment validation and which of these features are on.

The build does not fail when the Firebase variables are missing — pages render
empty and the build log prints one `[plansphere] Firebase web config is missing`
line — but the site will not work until they are set. After adding variables,
trigger a redeploy; `NEXT_PUBLIC_*` values are inlined at build time.

**Firebase console, once**

1. Authentication → Settings → Authorized domains: add `plansphere.in`.
2. Authentication → Templates → Customize action URL: `https://plansphere.in/auth/action`.
3. For the composite indexes used by the paginated admin tables, either grant
   the service account the *Cloud Datastore Index Admin* role in Google Cloud
   IAM and run `npm run firebase:deploy -- --indexes`, or run
   `npm run verify:infra` and click the six console links it prints. Public
   and student pages need no composite indexes.
4. `npm run verify:infra` until it reports 0 failed; `GET /api/health` on the
   deployed site reports the same checks from inside Vercel.

**Supabase dashboard, once**

1. Storage → New bucket: create `event-assets` (public), `avatars` (public),
   `certificates` (private) and `uploads` (private) — exact names, the app
   does not create them for you.
2. Project settings → API: copy the project URL and the `service_role` key
   into `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. Never put the service
   role key in a `NEXT_PUBLIC_` variable — see `src/server/storage/client.ts`.

## Security model, in one paragraph

Roles (`student` → `organizer` → `admin` → `super_admin`) are custom claims on
the Auth token, granted only by `POST /api/admin/staff` (super admin only).
Firestore rules trust the claim, never the profile document. Clients read
directly and write only what the rules allow; anything that must be atomic
or privileged — registration with capacity, results, certificates, staff —
goes through `app/api`, where `requireRole` verifies the token with
revocation checking and re-reads the account's `disabled` flag on every call.

## Further reading

- [`docs/SECURITY-ENV.md`](docs/SECURITY-ENV.md) — secrets handling and the dependency overrides in `package.json`
