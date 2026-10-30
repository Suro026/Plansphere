# Migrations — order, dependencies, tokens, recovery

Every script here is run by a person, against the service account, never by the app. Each is a **dry run unless told
otherwise**, and each that changes data records what it replaces in a backup *before* the change.

> **Correction (Phase 7).** This page used to say that of all the scripts, but `migrate:rbac` and `migrate:fests` actually
> *applied* unless given `--dry-run` and wrote no backup, `grant-super-admin` changed a role immediately, and
> `firebase:deploy` deployed on a bare invocation. All now follow the contract below
> (`scripts/lib/migration-cli.mjs`, exercised by `tests/emulator/migration-safety.test.ts`). Roll out in the order given under *Deploy order* below.

## The contract

| You run | It does |
|---|---|
| *(no flags)* | **Dry run.** Reads, prints the plan, writes nothing, exits 0. |
| `--apply --backup <new file>` | Makes the change. Appends the prior state of everything it will touch to the file *before* each change; refuses an existing file (a backup is never overwritten); the file is created `0600`. Reads each change back and exits non-zero if it is not what was written. |
| `--restore <file> [--apply]` | Recovery. A dry run unless `--apply`. Puts back only what the migration itself wrote **and nobody has changed since**, and lists what it kept. |
| `--dry-run` | Accepted, and what happens anyway. Combined with `--apply` it is refused. |
| any unknown flag | Refused (a typo such as `--aply` must not fall through to something else). |
| unusable `FIREBASE_SERVICE_ACCOUNT` | Stops before reading or writing, naming the cause (`private-key-only`, `not-json`, `missing-fields` …) and never echoing the value. |

| Script | Dry run default | `--apply` needs `--backup` | `--restore` | Read-back | Idempotent | Signs people out |
|---|---|---|---|---|---|---|
| `migrate:accounts` | yes | only with `--force` | no (the backup holds the replaced profile scope and claims, for a manual fix) | no | yes (skips accounts that have a profile) | yes — every account it writes |
| `migrate:rbac` | **yes (new)** | **yes (new)** | **yes (new)** | **yes (new)** | yes | yes — every account whose claims change; the dry run counts them |
| `migrate:fests` | **yes (new)** | **yes (new)** | **yes (new)** | **yes (new)** | yes | no |
| `migrate:event-head` | yes | yes | yes | yes (copy verified before the field is removed) | yes | no |
| `migrate:memberships` | yes | yes | yes | **yes (new: every membership read back; claims reconciled)** | yes | no (claims refresh at the next token) |
| `platform-staff` | yes (needs `--apply`) | no — it is a registry, every change audited | `remove` / `enforce off` | no (it refuses unsafe states beforehand) | yes | no |
| `grant-super-admin` | **yes (new)** | no | — | — | yes | yes |
| `firebase:deploy` | **yes (new)**: compares, changes nothing | — (`--save-rules <file>` saves the released rules first) | redeploy the saved rules | — | yes | no |

## Order

| # | Script | What it needs first | Why |
|---|---|---|---|
| 1 | `migrate:accounts` | — | **one-time import** from the previous project. Against a project already on the current schema its dry run should print only `skip`; any `write` line means stop and read. Never `--force` in production. |
| 2 | `migrate:rbac` | 1 | `organizer` → `volunteer`, `organizer.festIds` → `festIds`, claims `{role, festIds}` |
| 3 | `migrate:fests` | — | records `ownerId` (from `createdBy`) on fests that lack it |
| 4 | `migrate:event-head` | — | moves the Event Head's personal details off the public fest document into `festPrivate`; independent of 2, 3 and 5 |
| 5 | `migrate:memberships` | **2 and 3, and the new application code live** | turns pre-membership staff into event roles; the Event Head of a fest is its `ownerId`, which only 3 records |
| 6 | `platform-staff` | the code and rules deployed | registers the platform team and (optionally) enforces the boundary; see `PLATFORM-BOUNDARY.md` |

Which of these have already run on production is **not known from this repository**; every dry run reports "already
current" for finished work, so run them all as dry runs first (see *Deploy order* below).

**There is no data migration for event verification.** A fest without a `verification` field is a fest that predates the
review and reads as approved, exactly as before; only new self-service applications carry the field. What verification
*does* depend on is `ownerId` (3), for who is the applicant's fest, and the membership model (5) for the Event Head it creates.

**Do not re-run 1 or 2 after 5 without running 5 again.** Both write the account's claims as `{role, festIds}` and know
nothing of event roles, so they drop `br` / `fm` / `fx` from the token. Nothing is lost permanently — the app notices a token
that is behind its memberships and refreshes it, and `migrate:memberships` rewrites the claims — but until then the person's
direct Firestore access to the fest is gone.

## Deploy order (this phase's changes)

In short: **indexes → application code → `firestore.rules` → migrations →
`platform-staff`**.

1. **Indexes first** (`npm run firebase:deploy -- --apply --indexes`, then wait for READY): the analytics routes need seven
   that production does not have, and `/api/health` probes all of them.
2. **The application code, then `firestore.rules` straight after.** *(Corrected in Phase 8; this page used to say rules
   first.)* The committed build writes check-ins, meals and fest counters from the browser, which the new rules refuse, so
   rules-first breaks the live scanner (measured: the committed build on the new rules fails 27 of 383 emulator tests). The
   current code on the *released* rules passes every API and flow test, so code-first breaks nothing; it only leaves the old,
   broader read access in place until the rules follow. Approve no application and invite no staff between the two.
3. Run the migrations that have not run, in the order above, each as a dry run first.
4. `platform-staff` last, and `enforce on` only after the registry is confirmed.

Rollback of the rules is a redeploy of the previous file (kept with `firebase:deploy -- --save-rules`, or the console's Rules
history). Rollback of the code is a redeploy of the previous build — **but only before step 3.** After `migrate:memberships`
has run, an older build that predates memberships reads `festIds`, and the migration removed the fest from `festIds` (it moved
into `memberOf`): those staff would have no access under the older build. Run `migrate:memberships --restore <backup> --apply`
*first*, then roll the code back. The other leftovers (`fm` / `fx` claims, `platformStaff`, `festPrivate`) are inert to older code.

## `migrate:memberships`

```bash
npm run migrate:memberships                                       # dry run: plan, drift, headless fests
npm run migrate:memberships -- --report plan.json                 # ...and save it (ids and counts only)
npm run migrate:memberships -- --apply --backup backup.json       # make the changes
npm run migrate:memberships -- --restore backup.json              # recovery, dry run
npm run migrate:memberships -- --restore backup.json --apply      # recovery
```

What it does, per (person, fest) pair the old scheme gave access to, never granting more than they had: the fest's owner →
Event Head; any other admin → `admin` on every current sub-event; a volunteer → `volunteer` on every sub-event with the duties
they had (scoring only with an active scoring shift). Platform accounts, students, disabled accounts and fests that no longer
exist are left alone. A second Event Head is a reported conflict, never written.

Each run also **reconciles claims**: it compares the sign-in claims of everyone holding a membership with what their profile
and memberships imply (built by the same rules as the app, including the many-roles pointer), prints the count, and with
`--apply` rewrites the drifted ones. Because a failure in the last step of a pair leaves the pair "already done", this is how
that failure is repaired: **re-run `--apply`.**

It also lists the **fests that will have no Event Head** afterwards (no recorded owner). The platform assigns one with the
fest `transfer` action. Review the list before telling anyone the migration is finished.

### Tokens: what people see, and when

| Moment | API (the server) | Direct Firestore access (rules) |
|---|---|---|
| Immediately after the script | the live membership and the profile: the narrowed scope applies at once | the person's **old** token still lists the old fest-wide scope, so they keep the reach they had — never more, never less |
| After the token refreshes (within the hour, or at once when the app notices the mismatch and signs the person in fresh) | unchanged | the membership governs; an Event Head's later narrowing now applies here too |

The script does not revoke sessions. Narrowing therefore reaches direct Firestore access at the next token refresh (at most
about an hour); the API enforces it on the next request.

A revocation is cut off on the next request in both **for a token minted after the migration**, because the rules read the
membership document live. For a token minted *before* it, the old fest-wide scope in that token still opens the fest to
direct Firestore reads until the token refreshes (at most about an hour), even though the API has already refused. This is
the same limit any change to the legacy `festIds` scope has always had. If a revocation is urgent in that window, revoke the
person's sessions (Firebase console → Authentication → the user → Revoke sessions) so their token cannot be renewed.

### Failure and recovery

| What went wrong | State left behind | Recovery |
|---|---|---|
| The script stopped part-way | some pairs done, some not; each done pair is complete | re-run `--apply --backup <new file>`; it continues |
| A claims write failed (Auth outage, or a legacy scope too large for a token) | the membership and narrowed profile are committed; the claims are old | re-run `--apply`: the reconcile pass repairs it. A scope that cannot fit any token is reported as `CANNOT` and **never truncated**: move that person's fest-wide access to event roles, or shorten it |
| You want it all undone | memberships created by the script exist | `--restore <backup> --apply`: removes only memberships it created (`createdBy: "migration"`) that nobody has edited since, puts those fests back on the person's `festIds`, rebuilds `memberOf` and the claims. A migrated membership that was edited afterwards is **kept** and reported |
| The backup file is lost | — | the memberships are identifiable (`migratedFromLegacy: true`), and the pre-migration scope is the fest ids of those documents; restore by hand from the report |

The backup holds roles and fest ids, no names or emails; it is private and can be deleted once you are satisfied. The
script never overwrites an existing backup or report file.

## The app's own membership changes

Assigning, changing and revoking an event role commit the membership (and, on assign, the `memberOf` mirror the API uses to
find it) in one transaction. The claims are rewritten afterwards; if that fails, the change **still stands** (the API and
rules read the membership document), the audit entry is still written, and the response carries `claimsSync: "pending"` so the
Team screen can say so. The person's next visit repairs their claims (`/api/me/access`), and so does `migrate:memberships`.
