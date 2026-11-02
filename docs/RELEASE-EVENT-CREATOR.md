# Release guide — college event creators, notifications, platform boundary and dependency updates

What this release changes, the order to put it in production, how to bootstrap the platform boundary, and how to go back.
Nothing here runs by itself: every production step below is a separate, deliberate command.

## What changed

| Area | Change |
|---|---|
| Entry points | "Create a College Event" on sign-in (every tab), the landing page, navigation, footer, the for-colleges page and the 404 page. `/register-event` offers *Create an account* and *Sign in*, and returns the person to the application afterwards. |
| Copy | The Organizer tab and the Create account tab describe the real flow. The for-colleges page no longer says "no approval queue": every application is reviewed by the Plansphere team. |
| Role name | The stored role stays `head`. People see **Event Super Admin** everywhere. No data migration. |
| Existing staff | Admins and volunteers can apply with their existing account. Their role, legacy fest scope and event roles are untouched; approval adds one `head` membership on the new event only. |
| Emails | Applicant confirmation, reviewer alert, approval and rejection. A failed email is logged and never loses or undoes anything. |
| Approval | The status page refreshes by itself while an application is pending; "Open the console" repairs the claims and refreshes the token, so no sign-out is needed. Email verification is still required. |
| Team | The Event Super Admin can invite an admin, coordinator or volunteer before assigning competitions. An unassigned member can reach nothing. An event admin must still name competitions they work on. |
| Deploy script | `scripts/deploy-firebase.mjs` exits 1 and says `FAILED` for every refused index create (or any index in an error state). `Done.` only follows success. |
| Health | `/api/health` logs the fixed storage failure codes server-side (never a value) so Vercel logs name the cause without a super-admin session. The response now separates the application from its dependencies: the body adds `status` (`ok`, `degraded` or `down`), `application.available` and a verdict per service in `services`. The contract is otherwise the same: 200 only when every check passes, 503 otherwise, and a failing storage check is `degraded`, never `ok`. Every storage call is also bounded to 20 s, and a storage failure on an upload is a deliberate 503 (`storage-unavailable` / `storage-disabled`) instead of a 500. |
| Admin access | **A `volunteer` role with no fest and no event role is an ordinary (student) account; an `admin` is never lowered.** `roleWithScope` (`src/core/permissions.ts`) is applied by the server on every request (`authenticate`) and by the browser when it builds the session (`toSession`): such a volunteer lands in the Student section, sees no staff link and gets 403 from the staff APIs. An admin keeps its role whatever it holds, because what an admin may touch is decided per fest: an admin with an empty scope reaches no fest, event, person or platform page (`staff-scope-access.test.ts`). Nothing assigned is changed and no account's role changes. |
| Dependencies | `npm audit fix` (no `--force`): `@sentry/*` 10.75 → 10.78, `typescript-eslint` 8.70 → 8.72, `webpack` 5.111 → 5.112 and their patch-level companions. `package.json` is unchanged; only `package-lock.json` moved. 18 moderate advisories remain, all `minimatch` < 11.0.1, see below. |

## Security properties (each has a test)

* Creating or approving an event never produces `super_admin`: not on the profile, not in the claims (`event-creator-flow.test.ts`, `event-creator-journey.test.ts`).
* An Event Super Admin cannot read, change or staff another college's event, and cannot decide any application, their own included.
* With the platform boundary enforced, an Event Super Admin is not platform staff and an unregistered `super_admin` loses platform routes.
* Invite-now-assign-later grants nothing: a member with no competitions is refused on every competition.
* A storage failure never leaks the Supabase URL or key through the health response or the server log (`health-storage-failure.test.ts`).

## Remaining dependency advisories (18 moderate, 0 high, 0 critical)

All are one advisory, GHSA-g3hv-75wg-m249 (`minimatch` < 11.0.1, denial of service through pathological glob patterns), reached through:

* the ESLint toolchain (`eslint`, `eslint-config-next`, `typescript-eslint`, `eslint-plugin-*`): development only, not in the deployed bundle;
* `glob` 13 → `minimatch` 10 inside `@sentry/bundler-plugins` (the source-map upload plugin used during `next build`): build time only, and it globs the project's own build output, not user input.

`npm audit fix` cannot reach them: the fix is `minimatch` 11, a major version that the parents pin below (`^3`, `^10`). `npm audit fix --force` proposes
*downgrading* ESLint to 4.0.0, which would break linting, so it was not run. Overriding `minimatch` to 11 is not safe either: ESLint's plugins call
`require("minimatch")` as a function (the 3.x API) and the Sentry plugin cannot be exercised in CI (it only runs with an upload token), so an override would ship untested
into the production build. Re-check after the next `eslint-config-next` / `@sentry/nextjs` / `typescript-eslint` release; none of these paths executes at request time.

## Rules compatibility

The released ruleset in project `bits2bytes-b2b27` is byte-for-byte the rules at commit `091ad3f`; the copy saved on 31 Oct 2026 (Phase 20) is identical to the one saved earlier.
The repository's `firestore.rules` additionally defines `festMembers`, `festPrivate`, `payments*`, `paymentAccounts`, `paymentSecrets`,
`platformConfig`, `platformStaff` and the membership and boundary helper functions. This release changes the rules file once more: the Arena volunteer fix
adds one clause to the `allow list` of the shifts collection (`isOwner(resource.data.userId) && activeMember(resource.data.festId)`, +7/−1), so that a volunteer who works a
fest through an event role can read their own roster and nothing wider. The rules deploy as a whole file, so deploying them also brings in everything listed above.

* **New code on the old rules** (the state right after the code deploys): safe for every existing account and all five legacy fests, which are
  governed by the legacy `festIds` claim exactly as before. Every membership decision the app makes is on the server (Admin SDK); no browser code
  reads `festMembers`. What the old rules cannot do is let a *new* Event Super Admin's browser read their own draft event, because it has no
  legacy scope. **Deploy the rules before approving the first application.** Nobody holds a membership today.
* **New rules on the old code** (a rollback of the code): safe, because the legacy path (`legacyManages`) is kept.
* Order matters the other way too: rules before code breaks the live browser-side scanner (measured earlier). Code first, then rules.

## Before you start: state measured on 31 Oct 2026 (read-only)

| Item | State |
|---|---|
| Firebase project | `bits2bytes-b2b27` (the client bundle on plansphere.in carries the same id) |
| Firestore indexes | 16 READY, 0 building, 0 missing, 0 undeclared |
| Fests | 5, all legacy (4 published, 1 draft), all with an `ownerId` and no `verification` block |
| Memberships | 0 `festMembers`; `platformStaff` empty; `platformConfig/boundary` absent (boundary not enforced) |
| Accounts | 10: 5 `admin`, 1 `super_admin`, 4 `student`; the `super_admin` is not yet on the registry |
| Domains | `plansphere.in` 200; `www.plansphere.in` 308 → `https://plansphere.in/` |
| `/api/health` | every check passes except `storage` |

## Production data changed on 31 Oct 2026 (the only change)

| What | Detail |
|---|---|
| Record | `festMembers/kmnGsJV8FXM1N0vhZJwT__k8MMpMYqcCPdD2t4szYaYylBijB2` created: `role: head` (shown as Event Super Admin), `status: active`, `eventIds: []`, `duties: []`, `createdBy: migration` |
| Mirror | `users/k8MMpMYqcCPdD2t4szYaYylBijB2.memberOf` gained `kmnGsJV8FXM1N0vhZJwT` (`arrayUnion`) |
| Account | the NovaX owner (`surajitsadhukhan870@gmail.com`), global role `admin`, legacy `festIds: [NovaX]` (unchanged), already `ownerId` and `createdBy` of the NovaX fest |
| Not touched | the global role, the legacy `festIds`, the owner, every other membership and user, `platformStaff`, `platformConfig`, the fest and its event. The account is **not** a platform `super_admin` and is not on the platform registry. |
| Undo | delete that one `festMembers` document and `arrayRemove` the fest id from `memberOf`; the account keeps the legacy owner access it had. The pre-change values are in `D:\plansphere-backups\novax-head-before-20261031.json`. |

The sign-in claims were not rewritten: the app repairs them itself (`/api/me/access`, then a token refresh) the first time the account loads the new code. Until then access
works through the legacy ownership it already had.

**Who is affected by the access rule above.** Nobody in production. Three accounts hold the global role `admin` with no fest and no event role (their `organizer.festIds` is empty): they are the original
`organizers (admin)` accounts, migrated on 12 Sep 2026 without a fest, because the system they came from had none. They keep the role they were given and are shown the Admin Panel exactly as
today; being admins with an empty scope they reach no fest, event or person. If they are meant to run something, that is an assignment (a fest or an event role) and a separate decision. The
rule above lowers only a volunteer with nothing assigned, and production holds none. The NovaX owner, the second NovaX admin and the `super_admin` are unchanged, and the four published demo
fests are owned by a seed id that is not a real account, so no real admin loses access to them.

## Storage: the one thing that blocks `/api/health`

The `storage` check took 1.1 s and failed, so Supabase **answered** (a malformed URL or key is rejected locally in a few milliseconds, and the probe's timeout is 8 s).
That excludes `url-*`, `key-*`, `half-configured`, `project-mismatch`, `unreachable`, `upstream` and `wrong-url`. Keyless probes show the project is running and
`event-assets` and `avatars` exist and are public. What is left, and how to tell which:

| Code (in `/admin/health` and in the Vercel log line `[health] storage unhealthy: …`) | Meaning | Dashboard action |
|---|---|---|
| `unauthorized` | Supabase rejected the key (rotated, revoked, or from another project). The variables were last changed on 29 Oct, and this was the first deployment to read them. | Supabase → Project settings → API → copy the **`service_role` / secret** key of the project that hosts the posters. Vercel → Settings → Environment Variables → `SUPABASE_SERVICE_ROLE_KEY` (Production): re-save it, and check `SUPABASE_URL` is that same project's bare `https://<ref>.supabase.co`. Redeploy. |
| `bucket-missing(certificates)` and/or `bucket-missing(uploads)` | The two private buckets were never created. | Supabase → Storage → New bucket → `certificates` and `uploads`, **Public off**. |
| all four `bucket-missing(...)` | The URL/key now point at a different, empty project. | Same as `unauthorized`: point both variables at the project that holds the posters. |
| `bucket-should-be-private(certificates or uploads)` | A private bucket is public (identity documents and certificates would be readable by URL). | Make it private at once: Storage → bucket → Edit → Public off. |
| `bucket-should-be-public(event-assets or avatars)` | A public bucket is private; images would be broken. | Storage → bucket → Edit → Public on. |

To learn the code **without deploying anything**, either:

* open `https://plansphere.in/admin/health` signed in as the platform `super_admin` (the production code already shows the cause there, as `<code> (<bucket>): <sentence>`), or
* with the two Supabase values from the dashboard, set for one command only (read-only: it lists buckets, writes nothing, needs no Firebase credential, never prints the URL or key):
  `SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service_role key> npm run verify:storage`
  It prints each bucket as expected-versus-found and the fixed problem code(s), and exits 1 unless storage is healthy.

Deploying the code does not by itself fix storage: `/api/health` stays 503 until the dashboard action above is done.
Nothing in production has been changed. Environment changes need a redeploy to take effect.

## Production sequence

Each step needs its own approval. Stop and check after every step.

1. **Storage (outside the code).** Apply the dashboard action from the table above. Redeploy only if you changed a Vercel variable.
   While there, confirm in Vercel → Environment Variables (Production) that `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM` are set: with `console` the four
   new emails are written to `emailLog` and never delivered.
2. **Fresh backups** (read-only against production; the folders must be new and outside the repository):
   ```bash
   npm run backup:firestore -- --write D:/plansphere-backups/firestore-<timestamp>
   npm run backup:auth -- --write D:/plansphere-backups/auth-<timestamp>
   npm run backup:firestore -- --verify D:/plansphere-backups/firestore-<timestamp> --live
   npm run backup:auth -- --verify D:/plansphere-backups/auth-<timestamp> --live
   npx firebase-tools@15 emulators:exec --config scripts/restore-check.firebase.json --only firestore --project demo-restore-check "npm run backup:firestore -- --verify D:/plansphere-backups/firestore-<timestamp> --restore-check"
   ```
   The Firestore restore check must say `missing: 0   extra: 0   different: 0`. The Auth backup has no restore proof (its password-hash parameters come from the Firebase console).
3. **Publish the code.** Commit, then push to `main` (Vercel deploys production from `main`).
4. **Verify the deployment.** `https://plansphere.in/` is 200 and `https://plansphere.in/api/health` is 200 (503 only if step 1 was skipped).
5. **Deploy the rules** — after the code, before approving any application.
   ```bash
   npm run firebase:deploy -- --rules --save-rules D:/plansphere-final/rules-compare/released-<date>.rules   # read-only: the copy a rollback redeploys
   npm run firebase:deploy -- --apply --rules
   ```
   Never a bare `--apply` for this step; the indexes are already deployed (16/16 READY) and the script only ever adds missing ones. The script exits 1 if anything fails.
6. **Bootstrap platform staff.**
   ```bash
   npm run platform-staff -- list
   npm run platform-staff -- bootstrap --apply     # registers every enabled super_admin (today: one account). Nothing is enforced yet.
   ```
   Sign in as that account and confirm `/admin/platform` still opens.
7. **Enforce the platform boundary.**
   ```bash
   npm run platform-staff -- enforce on --apply    # refuses unless at least one registered, enabled super_admin exists
   ```
   Later, after the platform team has enrolled a second factor: `enforce on --require-mfa --apply`.
   **Way back at any time:** `npm run platform-staff -- enforce off --apply`.
8. **Smoke tests.**
   * Creator: a throwaway account → *Create a College Event* → both emails arrive → approve → *Open the console* from the status page without signing out → invite a coordinator before adding a competition → create competitions → the coordinator reaches none until assigned.
   * Legacy: sign in as an existing admin and open their fest; a student registers for an event of one of the five legacy fests; a volunteer's scanner loads its roster.

## Migrations

None are required. The five legacy fests keep their owner and their admins under the legacy scope. `npm run migrate:memberships` (dry run by default) can convert
legacy admins to event roles later; it is optional and must not be run as part of this release.

## Rollback

* **Code:** Vercel → the project's deployments → *Instant Rollback* to the previous production deployment (`d08ce6c`). The data model is unchanged, so this is safe at any time.
* **Rules:** put the file saved in step 5 in place of `firestore.rules` in a scratch checkout and run `npm run firebase:deploy -- --apply --rules` there.
* **Platform boundary:** `npm run platform-staff -- enforce off --apply`.
* **Indexes:** leave them. They only add capability and cost very little; deleting a used index breaks the date-range analytics queries.
* **Dependencies:** `git revert` of the commit restores the previous `package-lock.json`; `npm ci` then installs exactly the old tree.
* **An approved application that should not have been:** the platform hands the event to another account with the fest `transfer` action (the Event Super Admin cannot be changed from the event's own console). No data is lost.
* **Data:** the backups from step 2 restore the Firestore documents (`--restore-check` proves the Firestore restore); accounts come back with `firebase auth:import` and the hash parameters from the Firebase console.
