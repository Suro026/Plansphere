# File storage (Supabase) — setup, diagnosis, recovery

Every file the app stores — posters, avatars, certificate paper and PDFs, Event Head identity documents — goes through
`POST /api/uploads` into **Supabase Storage**, using the project's **service-role** key held only on the server. Firebase
Auth and Firestore are unaffected by anything here. If storage is down, uploads fail with "isn't enabled on this
deployment"; pages, sign-in, registration and the scanner keep working.

## What the app expects

| Bucket | Visibility | Holds | Why |
|---|---|---|---|
| `event-assets` | **public** | fest and event artwork, rulebooks | shown to anyone on public pages by permanent URL |
| `avatars` | **public** | profile photos | shown beside names |
| `certificates` | **private** | certificate paper (templates) and generated PDFs | personal; served by short-lived signed link |
| `uploads` | **private** | Event Head identity cards / authorization letters | identity documents; a reviewer opens one by signed link, audited |

The app never creates buckets. They are made by hand once per Supabase project, with exactly these names.

**A private bucket that is public is a data leak, not an outage.** Anyone who has (or guesses) an object URL can fetch an
identity document. The check below fails loudly for that case, and treats it as more urgent than a missing bucket.

Recommended bucket settings (Storage → the bucket → Edit bucket): set **File size limit** (`uploads` 8 MB, `certificates`
8 MB, `event-assets` 10 MB, `avatars` 3 MB — the same caps as `UPLOAD_POLICY`) and **Allowed MIME types**
(`image/png, image/jpeg, image/webp` for `avatars`; add `application/pdf` for `uploads`, `certificates` and
`event-assets`). The server already sniffs the bytes and enforces the caps; the bucket setting is a second wall if the
service-role key is ever misused. No storage policies are needed: the browser never talks to Supabase.

## Environment

| Variable | Value | Where it may live |
|---|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` — the bare project URL, no `/rest/v1` | server env (Vercel) |
| `SUPABASE_SERVICE_ROLE_KEY` | the **secret / service_role** key (Project settings → API). **Not** the anon / publishable key | server env only; never `NEXT_PUBLIC_`, never chat, never a commit |

**The names are exact.** The Supabase quick-start gives `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`;
this app reads neither (it does no storage from the browser), so a deployment that has only those has uploads **silently
off**. This was found in the Phase 7 audit in the local `.env.local`. The environment check (`/api/health`, the startup log
and `npm run verify:infra`) now names such variables — never their values — and says to set the two below. They can be
deleted.

Set **both or neither**. Only one of them set is a misconfiguration and fails the health check (it used to read as "off").
A value pasted with wrapping quotes or a trailing newline is cleaned before use. A key with a line break *inside* it is not
repaired, and is reported as `key-malformed`.

Keep Preview deployments off the production project: set these two variables for the **Production** scope only, or give
Preview its own Supabase project, so a preview build can never write to production buckets.

## Diagnosing

```bash
npm run verify:infra      # needs FIREBASE_SERVICE_ACCOUNT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.local
```

or, signed in as a super admin, open `/admin/health` (the unredacted view of `/api/health`). Anonymous callers get only
pass/fail per check. Both run the same diagnosis (`scripts/lib/storage-diagnose.mjs`), which lists the buckets **once** and
reports one cause per failure. It never prints the URL or the key, or any part of them.

| Code | Meaning | Fix |
|---|---|---|
| `half-configured` | only one of the two variables is set | set both, or neither |
| `url-invalid` / `url-has-path` / `url-not-https` | `SUPABASE_URL` is not the bare https project URL | copy it again from Project settings → API |
| `key-malformed` | whitespace or a line break inside the key | re-paste it as one line |
| `key-publishable` | the anon / publishable key is in `SUPABASE_SERVICE_ROLE_KEY` | use the secret / service_role key |
| `key-unrecognized` | not a key format Supabase issues | re-copy the whole key |
| `project-mismatch` | the key's project is not the URL's project | copy both from the same project |
| `unauthorized` | Supabase rejected the key (wrong, rotated or revoked) | re-copy the key; if it was rotated, update it everywhere |
| `unreachable` | DNS, network or timeout | check the URL; check the project is running |
| `upstream` | Supabase 5xx or a **paused** project | resume the project (free-tier projects pause when idle) |
| `wrong-url` | the host answered, but not as a storage endpoint | `SUPABASE_URL` is probably not the project URL |
| `bucket-missing (name)` | no bucket with that exact name | create it (table above) |
| `bucket-should-be-private (name)` | **a private bucket is public** | make it private **now**; then consider whether anything was fetched (Supabase → Logs) |
| `bucket-should-be-public (name)` | a public bucket is private | make it public, or its images will not load |
| `unknown` | an answer this check does not recognise | run `verify:infra` locally for the full message |

## Required state, in one table

| Item | Required | Local `.env.local` (29 Oct 2026, before it was emptied) | Production |
|---|---|---|---|
| `SUPABASE_URL` | bare project URL, https, no path | **missing** | unknown |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` secret, same project as the URL | **missing** | unknown |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | not read — delete | present (unused) | unknown |
| `SUPABASE_ANON_KEY` | not read anywhere (declared in the env schema only) — may stay unset | — | unknown |
| Bucket `event-assets` | exists, public | — | unknown |
| Bucket `avatars` | exists, public | — | unknown |
| Bucket `certificates` | exists, **private** | — | unknown |
| Bucket `uploads` | exists, **private** | — | unknown |
| Size caps / MIME types | per the recommendation above | — | unknown |
| Project running (not paused) | yes | — | unknown |

"Unknown" is literal: nothing here can read the production project. Fill the column in by
running `npm run verify:infra` (it also writes and deletes one probe object in `certificates`) or by reading `/admin/health`.

## What was and was not established

The health endpoint on production returned 503 only because of the storage check; every other check passed. The check
then reported every cause as "missing bucket" and production redacts the message, so **the actual cause on production has
not been established** — the local environment has no Supabase variables, and nothing was probed from here. The diagnosis
above exists so the next look at `/admin/health` names the cause directly. Fix what it names, redeploy, and expect `/api/health`
to return 200.

**Update (Phase 19).** The first deployment of this code returned 503 from `/api/health` on the storage check alone, although the previous
deployment passed it (30 Oct 2026, 19:10 UTC). The client code is the same apart from value cleaning; the check now lists the buckets once and also verifies each bucket's visibility, instead of
fetching each by name. The most likely cause is in what the new deployment reads rather than the code: the two Supabase variables were last changed
on 29 Oct, after the previous deployment was built, and a deployment keeps the environment it was built with, so this was the first deployment to use them.
This has not been proven, because the values cannot be read (they are Vercel "sensitive" variables).
Keyless probes showed the project running, `event-assets` and `avatars` present and public, and `certificates` / `uploads` not public. The code now logs
the fixed failure code(s) to the server log as `[health] storage unhealthy: <codes>` (never a value), so the next failure names its cause in the Vercel
runtime logs without a super-admin session. Read the `storage` line in `/admin/health` once to get the code, then use the table above.

**Update (Phase 20, 31 Oct 2026).** `/api/health` still fails on `storage` alone (every other check, including all 16 indexes, passes). The failed check took about 1.1 s, which
means Supabase answered: a malformed URL or key, a project mismatch or a missing variable are rejected locally in milliseconds, and the probe times out at 8 s. So the cause is one of
`unauthorized` (the key), `bucket-missing(certificates)` / `bucket-missing(uploads)` (the private buckets were never created), or all four buckets missing (the variables point at a different, empty
project). `docs/RELEASE-EVENT-CREATOR.md` has the table that maps each code to the exact dashboard action. `tests/emulator/health-storage-failure.test.ts` pins each of these: the check fails,
an anonymous caller sees pass/fail only, the server log carries the fixed code, and neither the URL nor the key appears anywhere.

**Update (Task 2, 2 Nov 2026).** Production `/api/health` was read again (HTTP 503, 12.5 s): every check passes except `storage`, which fails after 1.2 s, so
Supabase answers and the two variables are present (a missing, half-set or malformed pair fails locally in milliseconds). The Vercel project has `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` under the right names in Production and Preview (`SUPABASE_ANON_KEY` in Production only; the app does not read it; no Development variables). Both are Vercel
"sensitive" variables, so their values cannot be read back, and the cause is still one of `unauthorized`, `bucket-missing(certificates|uploads)` or a wrong-project key - read the code with
`npm run verify:storage` or the `storage` line of `/admin/health`. Two defects in the code were found and fixed regardless of that cause:

* **Storage failures surfaced as a 500.** Only a missing bucket had a deliberate answer; a rejected key, a paused or unreachable project, a timeout, or an unconfigured deployment
  (`StorageNotConfiguredError`) reached the API handler as an unrecognised error. `src/server/storage/guard.ts` now turns every failure of `storeUpload`, `createSignedUrl` and
  `deleteFile(s)` into a 503 (`storage-unavailable`, or `storage-disabled` with the "paste an https:// image URL" advice for an unconfigured deployment or a missing bucket), keeps a
  Supabase 413/415 as a 413/415, and logs one fixed code (`[storage] upload failed: unauthorized (uploads)`) - never the Supabase message, URL, key or path.
* **No timeout.** The Supabase client has none, so a project that accepts the connection and never answers held a request until the platform killed it. The client now gives up after
  20 s (`STORAGE_REQUEST_TIMEOUT_MS`), which the upload route (30 s) can still answer.

`/api/health` keeps its contract (`ok`, `checks`, 200 when everything passes, 503 otherwise) and adds `status` (`ok` | `degraded` | `down`), `application.available` and `services` (`application`,
`firebase`, `storage`, `payments`: `ok` | `failing` | `disabled`). Storage or payments failing is `degraded` (the app is up, one capability is not); Firestore, Auth, the Admin SDK or the environment
failing is `down`. Both answer 503 so a status-code monitor still alerts. Each check now has a time limit (20 s; 40 s for the index probe), so a dependency that hangs fails instead of holding the endpoint.
`storage` that is deliberately not configured reads `disabled`, not `ok`.

Tests: `tests/unit/storage-supabase-http.test.ts` runs the real `@supabase/supabase-js` client against a local server that speaks the Storage REST API (upload, public and signed retrieval, deletion,
rejected key, missing bucket, size and type refusals, a 5xx, a server that never answers); `storage-guard`, `health-report`, `uploads-api` (storage-down cases) and `health-status` cover the rest.
They prove the code; they cannot prove the production project's key or buckets.

## Recovering

1. Open `/admin/health` as a super admin and read the `storage` line.
2. Fix the named cause in the Supabase dashboard / Vercel env. If a key was ever pasted anywhere it should not have been,
   **rotate it** (Project settings → API → reset the `service_role` key), set the new value on Vercel, redeploy, and the old
   one stops working.
3. Reload `/api/health`; confirm 200. Upload a test poster as a fest admin; confirm the object appears in `event-assets`.
4. Confirm `uploads` and `certificates` are private (the check does this for you).

## Document uploads (Event Head identity)

- Kind `eventHeadIdentity`: an image or a PDF up to 8 MB, detected **by its bytes**, not its name or declared type. Images
  are re-encoded (metadata stripped, size bounded); a PDF is stored as uploaded.
- Stored in the private `uploads` bucket at `users/{uid}/identity/{random}.{ext}`; the owner segment is the caller's own
  uid, validated against `[A-Za-z0-9_-]{1,128}`; nothing in the path comes from the client except that uid.
- The application keeps only the object path. A reviewer opens it through a 5-minute signed link and every opening is
  audited (without the path or the link).
- `POST /api/uploads` is rate limited to 20 per 10 minutes per account.
