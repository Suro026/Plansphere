# Plansphere 9:16 product video — recording runbook

Everything in the video is the **real app** running against a **local Firebase emulator** (`demo-plansphere`). Nothing here touches production. Accounts, tickets and certificate numbers for the current seed are in `.demo-accounts.md` (repo root, git-ignored). Every demo password is printed at the top of `.demo-accounts.md` after seeding (it is `video-demo-2026-emulator-only` unless you set `DEMO_ACCOUNT_PASSWORD`; emulator-only, never a real credential).

## 1. Start (three terminals)

```bash
npm run demo:emulators   # Firebase Auth + Firestore emulators (data in .demo-data/)
npm run demo:seed        # once, ~12 min — builds the whole world
npm run demo:app         # Plansphere on http://localhost:3000, bound to the emulators
```

Re-run `npm run demo:clean && npm run demo:seed` on recording day: today's volunteer shifts are placed around the moment you seed, so "on shift now" has people in it. To discard anything created live while recording, stop the emulators **without** saving (delete `.demo-data/`) and seed again — records created through the UI are not tagged `demoBatch`, so `demo:clean` would not remove them.

## 2. Capture format — 1080 × 1920 (9:16)

- Chrome → DevTools → *Toggle device toolbar* → **Responsive**, **540 × 960**, **DPR 2**. That is exactly 1080 × 1920 when captured; the app switches to its phone layout (tap bar, stacked cards).
- Title cards: open `scripts/demo/video/cards.html#intro` (also `#what`, `#c03`…`#c20`, `#closing`; `#index` lists them; ← / → switch; `G` shows the unsafe bands). They use the **original `public/logo.png`**, untouched. Add `?actual` to view at 1:1.
- Safe zone: keep anything important **≥ 90 px from the sides, ≥ 240 px from the top, ≥ 420 px from the bottom** (Reels/Shorts/TikTok overlays). Add captions inside that box.
- Browser camera does not exist in the capture pane; the scanner's **"Enter code manually"** is the reliable path. With a webcam on the same machine you can also scan a QR shown on a phone.

## 3. Shot list (the 21-step story)

| # | Shot | Account | Where | What to do |
|---|---|---|---|---|
| 1 | Intro | — | `cards.html#intro` | Logo + tagline |
| 2 | What it does | — | `cards.html#what` | Register & Configure · Run Live Operations · Results & Certificates |
| 3 | **Register your event** | Kiran Patel (student, no fest yet) | `/for-colleges` → `/register-event` | Three steps: organization → event → event head. He becomes the fest's admin/owner (the app's "event-scoped super admin") |
| 4 | **Event created** | Kiran | `/admin/<new-slug>/overview`, `/f/<new-slug>` | Edit → publish; show the public page |
| 5 | **Super Admin dashboard** | Arjun Mehta | `/admin/novax-nexus-2026/overview` | KPIs, events today, live gate feed. Also `/admin/novax-nexus-2026/events`, `/analytics` |
| 6 | **Create / manage Admins** | Arjun | `/admin/novax-nexus-2026/staff` | Staff list (Riya Sen, Aditya Roy), *Create staff account*, **Pending** tab (Nikhil Bhatt) |
| 7 | **Volunteers** | Arjun | `/admin/novax-nexus-2026/volunteers` | Roster by post and duty, shifts, *Not activated* filter, scans today |
| 8 | **Student discovers** | Ananya Bose | `/explore` | "Happening now / Any time", city filter, search, grid/list; open `/f/novax-nexus-2026` |
| 9 | **Student registers** | Aditi Rao (no registrations) | `/f/novax-nexus-2026/e/pitch-perfect-startup-pitch` (team) or `.../codestorm-coding-contest` (solo) | Register; for teams show the join code |
| 10 | **Ticket** | Aditi | `/my-events` ("Ticket ready"), `/registered/<id>`, `/my-pass` | Ticket card with the participant, event and ticket code |
| 11 | **QR** | Aditi | same; public ticket page `/t/<ticket code>` | The one QR is also the meal coupon |
| 12 | **Volunteer scans** | Sneha Das | `/volunteer` → `/volunteer/novax-nexus-2026/scan` → CodeStorm | **Valid**: Priya's ticket (see `.demo-accounts.md`) · **Duplicate**: Rohan's · **Invalid**: `PS-0000000000` · **Cancelled**: Ishaan's · **Wrong event**: Priya's at PixelPerfect |
| 13 | **Attendance** | Arjun / Riya | `/admin/novax-nexus-2026/gate`, `/events/codestorm-coding-contest/registrations` | Check-in recorded once; "Checked in" filter |
| 14 | **Food & meals** | Kabir Singh | `/scan?fest=novax-nexus-2026&event=codestorm-coding-contest&mode=meal` (meal mode), CodeStorm snack | **Valid**: Ananya's · **Already used**: Rohan's. Admin: `/overview` meals served |
| 15 | **Live statistics** | Arjun | `/overview`, `/analytics`, `/gate` | Counters move after step 12–14 |
| 16 | **Certificates generated** | Riya (prepare) → Dev Kapoor (release) | `/admin/novax-nexus-2026/certificates`, `/admin/platform/certificates` | Workshop batch is *prepared, not released* — release it live as the platform owner |
| 17 | **In the student's account** | Ananya | `/certificates` | Winner · Participation · Second runner-up; pending and "after the event" states |
| 18 | **Public verification** | none | `/verify/<number>` (numbers in `.demo-accounts.md`) | Valid certificate with gate attendance; Download PDF; also a revoked one |
| 19 | **Explore other events** | any | `/explore` (Any time) | Aurora, Meridian, Orbit, HackHorizon, Genesis (past) |
| 20 | **Overview / analytics** | Arjun · Dev Kapoor | `/admin/novax-nexus-2026/analytics`, `/admin/platform`, `/admin/platform/analytics` | Trends, per-event funnel, platform totals |
| 21 | Closing | — | `cards.html#closing` | Logo + plansphere.in |

Secondary (a few seconds each): live scoring `/live` and `/admin/novax-nexus-2026/arenas` (RoboWars, Valorant — volunteer scorers Tanvi Joshi / Pooja Reddy at `/volunteer/live`), announcements (*Announce* on the overview), notifications `/notifications`, teams `/teams`, results `/admin/novax-nexus-2026/events/neural-sprint-ai-hackathon/results`, audit trail `/admin/platform/audit`, export center `/admin/reports`.

## 4. Accounts

| Role | Name | Email |
|---|---|---|
| Platform owner (super admin) | Dev Kapoor | dev.kapoor.demo@plansphere.demo |
| Event Head → fest admin/owner | Arjun Mehta (NovaX, 3 fests) | arjun.mehta.demo@plansphere.demo |
| Event Head | Meera Iyer · Karan Malhotra · Neha Kulkarni | meera.iyer / karan.malhotra / neha.kulkarni `.demo@plansphere.demo` |
| Admin | Riya Sen · Aditya Roy | riya.sen / aditya.roy `.demo@plansphere.demo` |
| Volunteer | Sneha Das, Rahul Sharma, Mohit Verma (entry) · Kabir Singh, Ishita Paul (meals) · Vikram Rao (help desk) · Tanvi Joshi, Pooja Reddy (scoring) | `first.last.demo@plansphere.demo` |
| Volunteer (invited, not activated) | Nikhil Bhatt | nikhil.bhatt.demo@plansphere.demo — cannot sign in (temporary password only) |
| Student — full journey | Ananya Bose | ananya.bose.demo@plansphere.demo |
| Student — checked in / duplicate scan | Rohan Gupta | rohan.gupta.demo@plansphere.demo |
| Student — not checked in | Priya Nair | priya.nair.demo@plansphere.demo |
| Student — register live | Aditi Rao | aditi.rao.demo@plansphere.demo |
| Student — "register your event" live | Kiran Patel | kiran.patel.demo@plansphere.demo |

## 5. What the product does not have (so it cannot be shown)

- **Payments**: no payment records, statuses or transactions. Entry fees exist on events (shown in the registrations table's *Payment* column and in revenue totals), but there is no pending / failed / successful state.
- **Food registration or separate coupons**: meals are per-slot on each event and scanned with the same ticket QR; there is no separate food sign-up or token.
- **Direct messages / chat**: communication is announcements and in-app notifications (plus email, which is logged to the console in this setup).
- **Profile photo / images**: upload needs Supabase Storage, which is not configured locally; the UI's designed placeholders are used.
- **Emulator-specific limits**: change-password and email-verification links call Google directly or send real mail, so new sign-ups cannot be verified end to end offline — use the pre-verified demo accounts.
