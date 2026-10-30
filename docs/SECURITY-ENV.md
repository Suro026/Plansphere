# Secrets & environment variables

Audit of 22 Sep 2026. Re-run any time with `npm run scan:secrets` (tracked
files, also a CI step) and `npm run scan:secrets:history` (every commit on
every ref). Neither prints a matched value.

## Where values may live

| Location | Contents | Reaches the browser? |
|---|---|---|
| Vercel project env (Production / Preview) | everything below | only `NEXT_PUBLIC_*`, inlined at build |
| `.env.local` (gitignored) | local copy of the same | same rule |
| `.env.example` (tracked) | **names only**, empty values | — |
| Source code | nothing — every value is read from `process.env` | — |

`next build` inlines `NEXT_PUBLIC_*` into client chunks by design. Nothing
else is referenced from client code; `src/server/**` and `src/app/api/**` are
the only readers of server variables, and `src/server/firebase-admin.ts`
throws if imported into a client component.

## Safe public variables (`NEXT_PUBLIC_*`, shipped to the browser)

| Variable | Why it is safe |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase web API keys identify the project; access is governed by Firestore/Storage rules and App Check, not by the key. **Restrict it to HTTP referrers `plansphere.in`/`*.plansphere.in` in Google Cloud → APIs & Services → Credentials.** |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `_PROJECT_ID`, `_MESSAGING_SENDER_ID`, `_APP_ID`, `_MEASUREMENT_ID` | Public project identifiers |
| `NEXT_PUBLIC_APP_URL` | The canonical origin |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSNs are write-only ingest addresses, public by design |
| `NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY` | reCAPTCHA *site* key (the secret key is never used — App Check verifies server-side with Firebase) |
| `NEXT_PUBLIC_VERCEL_ENV` | Vercel-provided environment name |
| `NEXT_PUBLIC_FIREBASE_EMULATOR`, `NEXT_PUBLIC_*_EMULATOR_HOST`, `NEXT_PUBLIC_APPCHECK_DEBUG` | Local development switches; unset in production |

## Server-only variables (never prefixed, never in client chunks)

| Variable | Secret? | Used by | Validated at startup |
|---|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | **yes** — bypasses all rules | `src/server/firebase-admin.ts`, scripts | required in production, **and must be readable**: the *whole* service-account JSON (raw or base64). The private key alone is rejected (`private-key-only`); an unreadable value is an error in production (`scripts/lib/service-account.mjs`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** — bypasses all storage policies | `src/server/storage/client.ts` | optional (set both Supabase variables or neither); uploads degrade gracefully without it. Setup and diagnosis: `docs/STORAGE-SETUP.md` |
| `SUPABASE_URL` | no (public project address) | `src/server/storage/client.ts`, health, `verify:infra` | with the key, or neither |
| `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_*` | — | **no reader in the code** (the env schema declares `SUPABASE_ANON_KEY`; only a warning mentions `NEXT_PUBLIC_SUPABASE_*`) | safe to leave unset or delete; never put the service-role key in a `NEXT_PUBLIC_` name |
| `RESEND_API_KEY` | **yes** | `src/server/email` | warning if provider=resend without it |
| `EMAIL_PROVIDER`, `EMAIL_FROM` | no | `src/server/email` | enum / default |
| `CRON_SECRET` | **yes** | `/api/cron/event-reminders` | warning in production if missing |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | **token yes** | build only (source-map upload) | optional |
| `APP_CHECK_ENFORCE` | no | `src/server/app-check.ts` | must not be `true` without a site key |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | **token yes** | `src/server/rate-limit.ts` | both or neither |
| `RATE_LIMIT_OVERRIDES`, `RATE_LIMIT_DISABLED` | no | rate limiting | parsed / switch |
| `PAYMENTS_ENABLED`, `PAYMENTS_LIVE_ENABLED`, `PAYMENTS_ALLOW_TEST_PROVIDER`, `PAYMENT_HOLD_MINUTES` | no | `src/server/payments/config.ts` | all off by default; warnings when half-configured. See `docs/payments-implementation.md` |
| `PAYMENT_SECRET_KEY` | **yes** — decrypts merchant credentials | `src/server/payments/secrets.ts` | error in production if `PAYMENTS_ENABLED=1` and not base64 of 32 bytes |
| `PAYMENT_SECRET_KEYS_PREVIOUS` | **yes** — decrypt-only older keys, comma-separated, used during a rotation | `src/server/payments/secrets.ts` | error in production if `PAYMENTS_ENABLED=1` and an entry is not base64 of 32 bytes |
| `ENV_STRICT` | no | startup: refuse to boot on a required-variable error | switch |
| `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, `GCLOUD_PROJECT` | no | tests / emulator development | — |
| `VERCEL_*` | no | provided by Vercel | — |

Startup validation lives in `src/server/env.ts` and runs from
`src/instrumentation.ts`; the same report is shown by `GET /api/health` and
`/admin/health`.

## Findings of the 22 Sep 2026 audit

**Tracked files:** no secrets. No API key, token, password, private key or
service-account material anywhere in the working tree. All credentials are
read from the environment.

**Client bundles (`.next/static`):** contain the `NEXT_PUBLIC_*` values only.
No service-account material, private key, Supabase service role key, Resend
key, cron secret, Upstash token or Sentry token. (The string `RESEND_API_KEY`
appears once, as the *name* in help copy on the admin console.)

**Git history (76 commits, all refs of the earlier private repository; this repository starts from a single commit):** no service-account key was ever
committed. Two historical items, both in code that no longer exists on
`main`:

1. The old Django backend (`legacy-history` branch, `pre-rearchitecture`
   tag) committed `backend/config/settings.py` with Django's auto-generated
   `django-insecure-…` development `SECRET_KEY`, and its compiled `.pyc`. The
   backend was deleted in the rebuild and was never deployed with that key in
   production use, so there is nothing to rotate. Delete the two refs from
   the remote when the old code is no longer needed for reference.
2. The Firebase **web** API key was hardcoded in the old Vite app
   (`src/lib/firebase.ts`, built `dist/` bundles, and `_legacy/` during the
   port). That key is public by design and is the same value now served via
   `NEXT_PUBLIC_FIREBASE_API_KEY`; restricting it by HTTP referrer (above)
   is the hardening step, not rotation.

**Removed hardcoded secrets:** none were present in the current code. The
audit added the scanner, the CI step, the ignore rules for key files
(`*.pem`, `*.p12`, `*.key`, `serviceAccount*.json`, `firebase-admin-key.json`,
`.sentryclirc`, `.vercel`) and `ENV_STRICT`.

## Operational reminders

- **Rotate the Firebase service-account key** if it was ever pasted into a
  chat, ticket or terminal shared with others: Firebase console → Project
  settings → Service accounts → Generate new private key → update
  `FIREBASE_SERVICE_ACCOUNT` on Vercel (base64 of the JSON) → delete the old
  key in Google Cloud IAM.
- Rotate `CRON_SECRET`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and
  Upstash tokens the same way: set the new value on Vercel, redeploy, revoke
  the old one at the provider (Supabase: Project settings → API → reset the
  `service_role` key).
- Vercel env scopes: keep Production values out of Preview unless a preview
  genuinely needs to send email or write to production Firestore (it should
  not).

## Dependency audit (30 Oct 2026)

`npm audit` (npm registry advisory database, run on 30 Oct 2026 against `package-lock.json`): **0 vulnerabilities** at every severity,
for production and development dependencies. Before this pass it reported **17** (2 critical, 12 high, 3 moderate; 11 of them in
production dependencies) because advisories had been published since the September audit.

This is a scan of *published* advisories for the *installed versions*. It is not a penetration test and does not verify any
deployment; new advisories appear continuously, so re-run `npm audit` regularly (and before every release).

| Package | From | To | Advisory (severity) |
|---|---|---|---|
| `next` and `eslint-config-next` (kept in step) | 15.5.25 | 15.5.28 | Unauthenticated remote code execution in the Image Optimization API with SVG files (critical); cache poisoning of SSG/ISR pages (2 advisories, moderate); denial of service through Server Actions (high) |
| `@sentry/nextjs` | 10.75.1 | 10.75.2 | Middleware bypass when the tunnel route is used (critical) |
| `zod` | 4.6.5 | 4.6.6 | Memory exhaustion when validating oversized constrained collections (high) |
| `sharp` | 0.35.4 | 0.35.5 | librsvg vulnerability (high) |
| `re2js`, `source-map-js`, `fast-uri` (transitive) | 2.8.6, 1.2.1, 3.1.8 | 2.9.1, 1.2.2, 3.1.9 | lookbehind denial of service (high); source-map denial of service (high); URI parsing issues (moderate) |
| `undici`, `brace-expansion` (transitive, development tooling) | 7.29.1, 1.1.18 / 5.0.9 | 7.30.1, 1.1.21 / 5.0.12 | several high/moderate denial-of-service and request-handling issues |
| `vite`, `vitest`, `@vitest/mocker` (development only) | 7.3.6, 5.0.1 | 7.3.7, 5.0.3 | dev-server and mock-registration issues (high/moderate) |
| `@grpc/grpc-js` (override, see below) | 1.9.16 | 1.14.5 | server-side gRPC authentication-context and error-message issues (high, low); this one entry also accounted for the `firebase`, `@firebase/firestore`, `@firebase/firestore-compat` and `@firebase/rules-unit-testing` findings |

Only patch or minor versions inside the existing semver ranges were used, plus the `next`/`eslint-config-next` patch pins; no `--force`
fix was applied. The unit and Firebase-emulator suites, the type check, lint and the production build were re-run after the changes.

### The `@grpc/grpc-js` override

`@firebase/firestore` (the Firebase web SDK, which this app also runs on the server for public pages and in the emulator tests) depends on
`@grpc/grpc-js ~1.9.0`, and every release checked, including the newest `@firebase/firestore`, still does. That range is inside the vulnerable
range (<1.13.6). The fix `npm audit` proposes, `firebase@9.14.0`, is a downgrade across three major versions and is not a real fix.
The advisories concern gRPC *server* APIs, which this application never starts; it only uses the client. To clear the finding without
downgrading, `package.json` pins `overrides["@grpc/grpc-js"] = "1.14.5"` - the version `firebase-admin` (via `google-gax`) already uses
in this tree. Verification: type check, unit tests and the 28-file emulator suite, which drives the Firestore web SDK over gRPC against the
emulator. **Not verified:** behaviour against a production Firestore project. Remove the override as soon as `@firebase/firestore` itself
depends on `@grpc/grpc-js >=1.13.6`.

### Earlier pass (22 Sep 2026)

`npm audit` then reported 12 (1 high, 11 moderate) and the following were applied; they are still in force:

| Advisory | Where | Action |
|---|---|---|
| `uuid` <11.1.1 buffer bounds (moderate) and the 7 advisories chained through it (`google-gax`, `gaxios`, `teeny-request`, `retry-request`, `@google-cloud/{firestore,storage}`, `firebase-admin`) | firebase-admin 13.x tree | `overrides.uuid = ^11.1.1`. firebase-admin stays on 13.x: 14.x pulls an ESM-only `jose` that the Vercel runtime cannot `require()` (production 500, fixed in Sprint 1). |
| `postcss` ≤8.5.22 XSS / source-map file read (high) | pinned 8.4.31 inside `next` | `overrides.postcss = ^8.5.28`; build verified. Next stays on 15.5.x — 16 is a major. |
| `@vitest/mocker` path traversal (moderate, dev only) | vitest 3 | upgraded to vitest 5 |
| `gaxios` (moderate) | transitive | `npm audit fix` |

Unused packages removed: eight `@radix-ui/*` components and `date-fns`
(never imported). `sharp` and `google-auth-library`, used by scripts but only
installed transitively, are now declared devDependencies.

Re-check after any `firebase-admin` or `next` upgrade: if a future version
requires a newer `uuid`/`postcss` than the override, remove the override.

## Error handling (22 Sep 2026)

All API routes run through `handler()` in `src/server/api.ts`, which delegates
to `src/server/errors.ts`:

| Thrown | Client gets | Logged as |
|---|---|---|
| `ApiError` (deliberate: 400/401/403/404/409/422/429/503) | its message and code; `Retry-After` on 429 | warning |
| `ZodError` | 400 + field names → messages | warning |
| `AdminNotConfiguredError` | 503 generic (production) / message naming the variable (development) | error + Sentry |
| transient Firestore (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `ABORTED`, lost transaction…) | 503 generic + `Retry-After: 3` | warning + Sentry |
| anything else | 500 generic + `requestId` | error + Sentry, full stack and context |

The `requestId` in a 500 matches the `[error]` log line and the Sentry event.
In development only, responses carry `debug: {name, message}` — never a stack.
Client-side, `toRepositoryError` replaces raw SDK/parse messages with the
operation context; browser camera errors are translated by name.

`GET /api/health` is redacted (pass/fail per check) unless the caller is a
super admin. Page-level: signed-out → sign-in; wrong role → 403 screen
(`AccessDenied`) or the fallback the layout chose; unknown URL → 404;
render failure → `error.tsx` / `global-error.tsx` with a digest, no message.

Regression suite: `tests/unit/error-handling.test.ts` throws hostile errors
(stack traces, filesystem paths, service-account strings, gRPC failures,
non-Error values) through the real `handler()` in production and development
mode and asserts none of a list of sensitive markers reaches the response.

## File uploads (updated 25 Sep 2026 — Supabase Storage)

One server path accepts every file: `POST /api/uploads?kind=…&id=…`
(`src/server/storage/upload.ts`). There is no client-side Storage SDK and no
Storage rules layer any more — nothing in the browser ever holds a Supabase
key, so a direct client write is not merely denied, it is not possible. Every
write goes through this route with the Supabase **service role** key, which
is server-only (`src/server/storage/client.ts` throws if it is ever imported
into client code) and is never exposed via a `NEXT_PUBLIC_` variable.

| Control | How |
|---|---|
| Type | magic-number sniffing (PNG/JPEG/WebP/GIF); the filename and declared Content-Type are ignored. SVG, HTML, executables, archives, scripts → 415 with a reason |
| Size | per-kind caps (2–10 MB) checked on the declared length, the received bytes and the processed output → 413 |
| Content | decoded and re-encoded with sharp: EXIF/XMP/IPTC/ICC dropped, orientation applied, longest side bounded, GIF flattened; polyglots come out as plain images |
| Names | `{fests|users}/{ownerId}/{folder}/{uuid}.{ext}` — owner id validated against `[A-Za-z0-9_-]{1,128}`, extension from the detected type, UUID name; nothing from the client |
| Authorization | fest banner/logo: admin managing the fest; event poster: organizer of the fest; profile photo: always the caller (the id parameter is ignored) — Firebase-based RBAC, unchanged by the storage migration |
| Location | Supabase Storage, per-kind bucket (`event-assets` public, `certificates`/`uploads` private, `avatars` public — see `UPLOAD_POLICY`), with `uploadedBy`, `kind` and `sha256` custom object metadata and an audit-log entry for fest artwork. Firestore stores only `{bucket, path, url}`, never binary data |
| Rate | `authenticated.uploads`: 20 per 10 minutes per account |
| Links typed by hand | `posterUrl`, `bannerUrl`, `logoUrl`, `photoUrl` accept `https://` only |

Certificates are cached best-effort in the private `certificates` bucket
(`users/{uid}/{number}.pdf`), but the link every recipient actually gets is
always the on-demand `/api/verify/{number}/pdf` route — never a stored URL —
because a signed URL into a private bucket expires and a certificate has to
keep working for years.

Tests: `tests/unit/uploads.test.ts` (sniffing, spoofed extension, executables,
SVG/HTML, oversize, EXIF stripping with orientation, bounding, GIF flattening,
random names, traversal ids) and `tests/emulator/uploads-api.test.ts`
(401/403 by role and fest, spoofed EXE → 415, oversize → 413, empty/missing
→ 400, stored object has random name, detected type, no EXIF, provenance
metadata, audit row).
