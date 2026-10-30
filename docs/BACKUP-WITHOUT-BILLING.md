# Backing up production without enabling billing

Decision of 29 Oct 2026: no Google Cloud billing account is linked ("Option B"). This page records what is and is not
possible without one, and how to use the two scripts that make a billing-free backup:

- `npm run backup:firestore` — every Firestore collection and document, types preserved
- `npm run backup:auth` — every Auth account with password hash, salt and custom claims

**Status:** both are implemented and tested against the emulators. **Neither has been run against production.** The first
production run is a separate approval.

## What is true of the project today (read-only checks, 29 Oct 2026)

| Fact | Value |
|---|---|
| Database | `(default)`, Firestore Native, Standard edition, `asia-south1`, **`freeTier: true`** |
| Size | **84 documents in 8 root collections, no subcollections** |
| Collections | `users` 10 · `fests` 5 · `events` 20 · `eventRegistrations` 37 (legacy; **no code references it**) · `students` 3, `organizers` 3 (legacy) · `auditLog` 5 · `emailLog` 1 |
| Auth | 10 users, all with password hash **and** salt, all with custom claims, provider `password` |
| Cloud Storage buckets in the project | 0 — on the free plan they cannot be created or reached |
| Firestore backups, schedules, PITR, exports | none |
| `gcloud` | not installed (and a managed export would not work anyway) |

## Options

| Option | Billing? | Possible now? |
|---|---|---|
| Firestore managed export, scheduled backups, point-in-time recovery, restore, clone | **Yes** | No |
| `firebase emulators:export` | no | exports the **emulator**, never production |
| Firebase CLI Firestore commands | no | there is **no data-export command** |
| `firebase auth:export` | none documented | probably; exports only scrypt hashes, may omit claims, needs an Owner/Editor login |
| **`npm run backup:firestore`** | **No** | **yes** |
| **`npm run backup:auth`** | **No** | **yes** (hash, salt, claims, providers) |

With no billing account linked nothing here can be charged. Going over the free read quota returns errors, not charges. A full
read of this database is about 84 reads against 50,000 a day; the scripts refuse to read more than 10,000 documents unless you
raise `--max-documents`, because a large read could use up the day's quota and take the live app down.

---

## Commands for you to review

Nothing below has been run against production. Run them in Windows PowerShell from the repository folder.

**One-time: a folder for backups that is outside the repository** (the scripts refuse any path inside it):

```powershell
New-Item -ItemType Directory C:\plansphere-backups
```

**1. Dry runs — read-only, print counts only, write nothing:**

```powershell
npm run backup:firestore
npm run backup:auth
```

Expect `DRY RUN`, `8 collection(s), 84 document(s)` (Firestore) and `accounts 10` (Auth). No name, e-mail or id is printed.

**2. Write the backups** (each needs a NEW folder name; it refuses one that exists):

```powershell
$d = Get-Date -Format "yyyyMMdd-HHmm"
npm run backup:firestore -- --write C:\plansphere-backups\firestore-$d
npm run backup:auth      -- --write C:\plansphere-backups\auth-$d
```

Expect `Verification: VERIFIED` for both, and the exit code 0. The scripts check every file they wrote (hash, record count,
structure) and compare the live counts with what they wrote before they write the manifest.

**3. Verify the files later, offline (no credential, no network):**

```powershell
npm run backup:firestore -- --verify C:\plansphere-backups\firestore-$d
npm run backup:auth      -- --verify C:\plansphere-backups\auth-$d
```

**4. Compare with production (read-only) — detects change since the backup:**

```powershell
npm run backup:firestore -- --verify C:\plansphere-backups\firestore-$d --live
npm run backup:auth      -- --verify C:\plansphere-backups\auth-$d --live
```

Run it again immediately before the first migration or rules deploy. A difference means the app has been used since; take a
fresh backup.

**5. Prove the Firestore backup restores** — into a throw-away **emulator**, never production. It refuses to run unless an
emulator is running, and refuses an emulator that already holds documents:

```powershell
npx firebase-tools@15 emulators:exec --config scripts/restore-check.firebase.json --only firestore --project demo-restore-check "npm run backup:firestore -- --verify C:\plansphere-backups\firestore-$d --restore-check"
```

Expect `Restored 84 document(s) … compared 84 field by field`, `missing: 0   extra: 0   different: 0`, `The backup restores
exactly.` (The count is whatever the manifest says.) This command was rehearsed end to end on a throw-away emulator with a seeded
database. Until it passes, treat the dump as a file, not a backup. The Auth backup has no equivalent restore proof (below).

---

## What each file contains

```
firestore-<date>/
  manifest.json          project id, timestamps, per-collection counts, SHA-256 of every file, verification status
  MANIFEST.sha256        SHA-256 of manifest.json (so editing the manifest is noticed)
  firestore/0001-<collection>.ndjson …   one file per collection (subcollections have their own file); one document per line

auth-<date>/
  manifest.json, MANIFEST.sha256
  auth/users.ndjson              one account per line, exactly as the Admin SDK reports it
  auth/firebase-auth-import.json the same accounts in the format `firebase auth:import` reads
```

**Never in a backup:** the service-account key, any API key, any environment variable. The manifest writer refuses to write a
manifest that mentions credential material, and the tests scan every file for it.

**Fidelity.** Firestore values are written as typed JSON, not plain JSON: integers, doubles (including NaN, Infinity, −0),
timestamps, geo points, document references, bytes, nested maps and arrays all survive, and a user map with a field named `$`
cannot be mistaken for a type tag. A value the format cannot hold stops the backup with an error; it is never dropped.

---

## Limitations — read before relying on it

1. **Not an atomic snapshot.** Documents are read over a few seconds. The script compares live counts after the read and records
   any change as a failed check, but a document edited (not added or removed) during the run would not be noticed. With this
   project's traffic that is a negligible risk; take the backup at a quiet time.
2. **Whole-number doubles come back as integers.** The Node SDK writes a double like `1.0` as the integer `1`. `--restore-check`
   reports exactly that as a difference. (Not known to occur in this data; the check tells you.)
3. **Timestamps keep microseconds,** which is all Firestore stores.
4. **`createTime` / `updateTime` are recorded for information and cannot be restored.** Rules, indexes, Auth, Supabase files and
   environment variables are not in the Firestore backup (rules: `scratchpad/gate1/rules-before.txt` and git; indexes:
   `firestore.indexes.json`; environment: Vercel).
5. **No restore tool writes to production.** `--restore-check` writes only to the emulator. If you ever need to restore to
   production, that is a deliberate, separately-approved operation — the typed files make it possible, but no script for it
   exists, on purpose.
6. **Auth restore is not proven.** The accounts file is exact (hash, salt, claims). The CLI import file is built to the
   documented format, but the emulator cannot validate password hashes, so a real `firebase auth:import` has not been rehearsed.
   The project's **password-hash parameters** (signer key, salt separator, rounds, memory cost) are not readable through the Admin SDK and
   are **not in the backup**; a restore needs them from the Firebase console (Authentication → Users → ⋮ → *Password hash
   parameters*). Record them somewhere safe now. Sessions are not restored; claims are.
7. **A vector-valued field cannot be restored** (the tool refuses rather than guess). None exists today.
8. **Memory:** a backup is held in memory while it is written. That is fine at this scale and is capped by `--max-documents`.
9. **Supabase files are not covered.** Their retention on the Supabase plan is unknown here.
10. **One machine, one copy** is not a backup strategy. Keep at least two copies of the encrypted archive in two places you control.

---

## It contains personal data — encryption, handling, retention

The Firestore backup holds names, e-mail addresses, phone numbers and registrations. The Auth backup holds **password hashes and
salts**, which let someone attack the passwords offline. Treat both like passwords.

- **Never in Git.** The scripts refuse any folder inside this repository, and `.gitignore` has a safety net for folders named
  `backups/` or `*-backup-*`. Do not put them in the project folder, OneDrive/Google Drive/Dropbox sync folders (the plaintext
  would be uploaded), e-mail, chat, tickets, or any AI tool.
- **Encrypt before it leaves this machine.** Simplest on Windows: [7-Zip](https://www.7-zip.org/) with AES-256 and encrypted
  file names, passphrase typed at the prompt (do not put it on the command line, where it lands in shell history):

  ```powershell
  & "C:\Program Files\7-Zip\7z.exe" a -t7z -mhe=on -p C:\plansphere-backups\plansphere-$d.7z C:\plansphere-backups\firestore-$d C:\plansphere-backups\auth-$d
  & "C:\Program Files\7-Zip\7z.exe" t -p C:\plansphere-backups\plansphere-$d.7z      # test: prompts for the passphrase, must report "Everything is Ok"
  ```

  Use a long random passphrase from a password manager, stored **separately** from the archive. Or keep the folder on a
  BitLocker-encrypted drive. (`Compress-Archive` does not encrypt.)
- **Check you can open it** before deleting the plaintext folders.
- **Retention:** keep the encrypted archive until the rollout is verified and then for a short, decided period (suggest 30 days)
  in case a problem surfaces late; then delete every copy. A backup of personal data you no longer need is a liability.
  Deleting a file on an SSD does not reliably erase it, which is why the archive must be encrypted: deleting the passphrase is
  what makes old copies unreadable.
- **Access:** only the person doing the rollout. Do not email the passphrase with the archive.

## What stays blocked without a managed backup

- Point-in-time recovery and one-command restore need billing; revisit after launch (scheduled backups with short retention are the
  cheapest route).
- Supabase file backups.
- An atomic-snapshot guarantee.

Every migration that would change data has its own `--backup` / `--restore` (`MIGRATIONS.md`), and the two that would write
today are tiny (`fests`: one field on one fest; `memberships`: 2 memberships, 2 profiles).
