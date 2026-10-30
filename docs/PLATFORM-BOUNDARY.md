# Platform boundary — who may act as the platform team

`super_admin` is the platform team: it creates and reviews fests, approves payment accounts, publishes certificates and
reads the platform-wide audit log. Event organizers (an Event Head, an event admin, a coordinator, a volunteer) are **never**
the platform; their power is a membership on one main event and ends at it.

Until now the platform was one claim, `role: super_admin`. Anything able to mint that claim — or one stolen super-admin
password — was every platform power at once, with no second condition. The boundary adds that second condition.

## What is implemented

| Layer | What it does |
|---|---|
| **Registry** `platformStaff/{uid}` | The accounts allowed to act as the platform: `{ status: active \| suspended \| removed }`. Written **only** by `npm run platform-staff` against the service account. No route, page or rule writes it, and rules deny every client read and write. |
| **Switch** `platformConfig/boundary` | `{ enforce, requireMfa }`. Absent, or `enforce` not exactly `true` = the old behaviour (the role claim alone). Same denial for clients. |
| **API** (`authenticate`) | With `enforce` on, a caller whose token says `super_admin` but who is not an **active** registry entry is an ordinary student to every route, on the very next request (no sign-in needed). The refusal says why (`Platform access is not enabled…`). With `requireMfa`, the token must also carry `firebase.sign_in_second_factor`. |
| **Rules** (`platformOk()`, folded into `role()`) | The same decision for direct Firestore access. A turned-away super admin reads as a student to `isStaff` / `isAdmin` / `isSuperAdmin` and every rule built on them, not just a few. |
| **Minting** | Once enforced, the staff API refuses to create or promote a `super_admin` (422): that account would carry the role and none of the power. Demoting or deleting a platform account removes its registry entry. |
| **Script** `npm run platform-staff` | The only way to change the registry or the switch. Dry-run unless `--apply`. Refuses to enforce with nobody registered, refuses `--require-mfa` unless every registered account has enrolled a factor, refuses to remove/suspend the last usable account while enforced. `enforce off` is always allowed (the way back from a lockout). Every change writes an audit entry. |
| **`grant-super-admin`** | Also registers the account, so a freshly granted platform member works once enforced. |

The registry is a **second condition on top of the role, never a replacement for it**: an account that is not already a
`super_admin` gains nothing by being listed (tests list organizers and Event Heads on the registry and show they stay
unprivileged). Nothing an Event Head, approval, membership or invitation does can reach the registry.

## What it does and does not protect against

| Threat | With the boundary enforced |
|---|---|
| An organizer or Event Head reaching platform power | Not possible: role claim `super_admin` is required, and only the script mints that. Verified in rules and API tests. |
| A bug or attacker minting a `super_admin` claim/profile through the app | The new account is not on the registry, so it has no power. The app refuses to try. |
| A stolen super-admin **password** | Not stopped by registration alone. **Stopped only once `requireMfa` is on and the platform team has enrolled** (below). |
| A compromised super-admin **session** | Can still act as that member until revoked. It cannot register accounts, un-enforce the boundary or change the registry: no client path writes them. |
| Someone with the Firebase **service account** | Out of scope: that credential bypasses rules and can write anything, including the registry. Protect it (`docs/SECURITY-ENV.md`). |
| Event organizers and the platform sharing one identity pool | Not changed. A separate identity boundary needs a separate Firebase project (below). |

## Rollout (nothing changes until the last step)

1. Deploy the code and `firestore.rules`. With `platformConfig/boundary` absent the system behaves exactly as before.
2. `npm run platform-staff -- list` — shows the registry, the switch, and any super admins **not** on the registry.
3. `npm run platform-staff -- bootstrap --apply` — registers every enabled super admin (or `add <email> --apply` one by one).
4. `npm run platform-staff -- list` again; confirm everyone who should have platform access is `active`.
5. `npm run platform-staff -- enforce on --apply`. Sign in as a registered member and open `/admin/platform`; also confirm an
   organizer account still cannot.
6. **Recovery**, if anyone is locked out: `npm run platform-staff -- enforce off --apply` (works with the service account
   alone), fix the registry, enforce again. A super admin not on the registry sees "Platform access is not enabled for this account".

Order matters: register **before** enforcing. The script refuses `enforce on` with nobody registered, but it cannot know who
you intended to register.

## Prerequisites for turning enforcement on (checked against the code, Phase 7)

All must hold before `enforce on`. None has been done; **enforcement is off** and this document does not enable it.

1. **The rules and the code with `platformOk()` / `resolvePlatform` are deployed** (code first, then rules). Before
   that the switch document is ignored by whatever is deployed.
2. **`platformConfig/boundary` is absent or `enforce` is not `true`** — the starting state; `platform-staff list` shows it.
3. **Every account that needs the platform is a `super_admin` and `active` on the registry.** Review `list` first: it also
   shows `super_admin` accounts *not* on the registry (stale, test or shared accounts — disable or demote those rather than
   registering them). `bootstrap` registers every *enabled* super admin, so read before `--apply`.
4. **At least two active registered accounts**, so one lost password cannot lock the platform out. (The script refuses to
   enforce with none, and refuses to remove or suspend the last usable one while enforced; it cannot check that you
   intended two.)
5. **Each registered person has signed in and opened `/admin/platform` after step 3** — proves the claim and the registry agree.
6. **The recovery command is known and works from the operator's machine**: `npm run platform-staff -- enforce off --apply`
   needs only the service account (so a working `FIREBASE_SERVICE_ACCOUNT` is itself a prerequisite).
7. **Rollback of the rules is understood**: with enforcement on, never roll the rules back to a file without
   `platformOk()` while an unregistered `super_admin` exists, or direct Firestore access reopens for it.
8. **Do not pass `--require-mfa`.** It needs the Identity Platform configuration and the enrollment/sign-in screens below,
   neither of which exists. With it on, nobody could sign in as platform staff.

What enabling it does *not* give: protection against a stolen super-admin password (that needs MFA), or against the service
account. `GET /api/me/access` returns `platformDenied` for a turned-away super admin but **no screen shows it yet** — the
account simply behaves as a student.

`grant-super-admin` is now a dry run unless `--apply`, and refuses an account that holds event roles (an Event Head must not
become the platform): use a separate address for platform accounts.

## Second factor (MFA) — the exact prerequisite

`requireMfa` makes the boundary check `firebase.sign_in_second_factor` on the ID token. Firebase only issues that after a
user has **enrolled** and **signed in with** a second factor, which this project cannot do today:

1. **External configuration (cannot be done from this repository).** Upgrade the Firebase project to *Firebase
   Authentication with Identity Platform* (Google Cloud Console → Identity Platform; needs billing), then enable
   multi-factor authentication and the **TOTP** provider (Firebase console → Authentication → Sign-in method → Advanced →
   Multi-factor authentication). Enrolling a second factor also requires a **verified email** on the account.
2. **App work that is not built** (the sign-in page has neither): an enrollment screen using `multiFactor(user).getSession()`,
   `TotpMultiFactorGenerator.generateSecret`, `assertionForEnrollment` and `multiFactor(user).enroll`; and a sign-in step that
   catches `auth/multi-factor-auth-required`, reads `getMultiFactorResolver`, and finishes with
   `TotpMultiFactorGenerator.assertionForSignIn` + `resolveSignIn`.
3. **Enrollment** for every registered platform account, then `npm run platform-staff -- enforce on --require-mfa --apply`
   (it refuses while any registered account has no enrolled factor, and tells you who).

**Do not turn on `requireMfa` before steps 1–3.** Until then the boundary gives you a closed, auditable registry but not a
second factor. This is stated here so it is not mistaken for MFA.

The API check is unit-tested against the same table as the rules, and the rules are tested with and without the claim. The
Auth emulator cannot mint a second-factor sign-in, so the positive API path with a real second factor is covered by the pure
decision test and by the rules test, not an end-to-end sign-in. Verify it on a staging project once step 1–2 are done.

## A separate identity boundary (option, not built)

Event organizers and the platform team sign in to the same Firebase project. The strongest separation is a **second
Firebase project (or an Identity Platform tenant) used only by the platform team**, with its own service account, its own
App Check and its own domain, so an organizer identity can never even collide with a platform one. That is an architectural
change (a second Auth issuer, the API verifying tokens from two projects) and outside this phase. The registry + MFA above are
the strongest boundary the current single-project architecture supports.

## Remaining risks

- Until `requireMfa` is enabled, a stolen super-admin password is still enough. Enrol the platform team first.
- The platform team's own UI still shows platform menus to a super admin who has been turned away (the API and rules refuse);
  `GET /api/me/access` returns `platformDenied` so a banner can be added.
- `countActiveSuperAdmins` (the in-app last-super-admin guard) counts profiles, not the registry; the script's guard counts
  the registry. Use the script for anything that changes who is on the platform team.
