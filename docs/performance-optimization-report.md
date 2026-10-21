# Plansphere — performance & reliability audit

Date: 2026-10-21 · Code audited: commit `21b459a` (clean tree) · Next.js 15.5.25, React 19.1, Firebase JS SDK 12.19, three 0.186.

This was a targeted pass: inspect, measure, fix what the evidence supports, leave the rest as recommendations. Nothing was committed or pushed, no branches were created, and no environment variables, Vercel/Firebase settings, schemas or auth/authorization code were touched.

## 1. How things were measured (and what that can and cannot tell you)

**Lab only, on one Windows laptop.** There is no field data (no Core Web Vitals from real users) and no Lighthouse run: Lighthouse is not installed in the repo and installing it was out of scope. Instead a Playwright script (Chromium, `PerformanceObserver` for LCP / CLS / long tasks, CDP for transfer sizes) measured a local **production build** (`next build` + `next start`) against the **local Firebase emulators** with the seeded demo data (project `demo-plansphere`; no production credentials were used).

- Desktop: 1440×900, unthrottled. Mobile: 390×844, 4× CPU slowdown, 1.6 Mbps / 150 ms RTT.
- Cold cache per run; median of 3 runs (5 for re-checks). "TBT" is the sum of main-thread long-task time beyond 50 ms after first paint.
- WebGL was software-rendered (SwiftShader) unless a row says "real GPU" (NVIDIA RTX 5050 laptop, D3D11).
- **Timings are noisy.** The same build gave mobile explore-page TBT of 648, 943 and 988 ms on different runs, and desktop LCP varied by ±200 ms. Only differences far outside that band — bytes transferred, Firestore read counts, hydration-error rates, and the multi-second 3D-scene stalls — are claimed below. LCP/TBT deltas of a few hundred ms are **not** evidence of anything.
- The authenticated pages were measured by signing in to the emulator with the seeded demo organizer account.

Measurement scripts and raw JSON are outside the repo, in `../perf-audit/`.

## 2. Baseline

| Check | Result at `21b459a` |
|---|---|
| `tsc --noEmit` | clean |
| `eslint .` | 1 error, 2 warnings — all pre-existing: the error is in the git-ignored generated `next-env.d.ts`; the warnings are `<img>` in the two OG-image routes |
| Unit tests (`npm test`) | 25 files, 293 tests pass |
| Emulator tests (`npm run test:emulator`) | 13 files, 206 tests pass (rules, registrations, scanning, certificates, live events, admin) |
| Production build | passes |
| Known production failure | A Vercel deploy failed in `next/font/google` (Google Fonts fetch at build time). A later production deploy of the same code succeeded, so this was transient and unrelated to performance. |

First Load JS (build route table, gzip):

| Route | Baseline |
|---|---|
| shared by all | 137 kB |
| `/` | 441 kB |
| `/explore` | 441 kB |
| `/f/[festSlug]` | 461 kB |
| `/f/[festSlug]/e/[eventSlug]` | 480 kB |
| `/sign-in` | 264 kB |
| `/admin/[festSlug]/overview` | 265 kB |

## 3. Bottlenecks found

Ranked by what the measurements showed.

1. **A 79 kB Sentry browser SDK on every page, for a monitor that cannot send anything.** `src/instrumentation-client.ts` (and both error boundaries) imported `@sentry/nextjs` statically. The repo's own health route and `.env.example` say no `NEXT_PUBLIC_SENTRY_DSN` is configured, so `Sentry.init({ enabled: false })` ran with the whole SDK downloaded and parsed first. *Fixed.*
2. **The 3D hero scene stalls the main thread** (introduced earlier today). Software-rendered WebGL: long tasks up to 5 s and ~2 s per frame, TBT 4–13 s. Real GPU: a single 0.9–1.2 s task at start-up on desktop; at 4× CPU slowdown TBT was 2.7–3.1 s versus 0.4–0.6 s without it. A CPU profile shows the time is shader linking (`getProgramParameter`) during the first draws. On phones the scene is non-interactive (rotation/zoom are off so the page can scroll) so it was pure cost. *Partly fixed (gated); the desktop stall remains.*
3. **A latent hydration race on the fest page.** `CountUpController` is mounted at the root and rewrites the text of every `[data-countup]` number immediately, before the page's own boundary has finished hydrating. That gives React error #418 and throws the boundary away to be client-rendered. Baseline: 1 of 10 throttled-mobile loads of `/f/<fest>`. After removing the Sentry chunk (which shifted timing), the same code hit it in **8 of 10** loads — so any speed-up would have made a real bug common. *Fixed.*
4. **Duplicate Firestore reads.** `generateMetadata` and the page each fetched the same documents: 3 reads per fest-page render and 4 per event-page render. *Fixed (3→2, 4→2).*
5. **The fest and event pages are not cached at all.** Both export `revalidate` (60 s / 30 s), but with no `generateStaticParams` Next renders them dynamically: the responses carry `Cache-Control: private, no-cache, no-store` and every view does the Firestore reads. `/` and `/explore` by contrast are served `s-maxage=60, stale-while-revalidate`. *Not fixed — see recommendations; it needs a small correctness change and a preview-deployment check.*
6. **Firebase is downloaded on every page.** Even `/sign-in`, `/explore` and the landing page fetch Firestore (67 + 39 kB gz), Auth (27 kB) and zod (29 + 15 kB) after hydration, because `Providers` loads the auth service on mount to know whether to show "Sign in" or the account menu. The "lazy Firebase boundary" in `providers.tsx` defers it past first paint but not past the page load. *Not changed (touches auth timing).*
7. **`/sign-in` renders client-side.** The page uses `useSearchParams`, so the server HTML contains only skeletons (`BAILOUT_TO_CLIENT_SIDE_RENDERING`). FCP is ~0.75 s but LCP is 2.4–2.9 s on throttled mobile because the form waits for ~510 kB of JS. *Not changed.*
8. **Authenticated admin pages are slow on a throttled phone.** FCP ~4.0–4.5 s, LCP 4.4–4.9 s (client-rendered after auth + Firestore). *Not changed.*

## 4. Changes made

Seven source files; no new dependencies.

| File | Change | Why |
|---|---|---|
| `src/instrumentation-client.ts` | `Sentry.init` now runs inside `if (dsn) import("@sentry/nextjs").then(...)`. | Removes the SDK from every page load when no DSN is configured. |
| `src/app/error.tsx`, `src/app/global-error.tsx` | `captureException` via on-demand `import("@sentry/nextjs")`. | They were the other static importers that kept the SDK in the layout bundle. Only loads when something has already failed. |
| `src/app/f/[festSlug]/page.tsx` | Fest lookup wrapped in React `cache()`, shared by `generateMetadata` and the page. | One Firestore read instead of two per render. Same `.catch(() => null)` semantics as before. |
| `src/app/f/[festSlug]/e/[eventSlug]/page.tsx` | `load` wrapped in `cache()` and keyed on the two slug strings (so arguments stay primitive). | Two reads instead of four per render. |
| `src/components/ui/count-up.tsx` | A number is animated only once React has claimed its DOM node (`__reactFiber$…` present); otherwise it keeps its server-rendered value, with a 15 s cap. | Removes hydration error #418. |
| `src/app/_landing/machine-hero-loader.tsx` | The 3D machine is skipped on touch/coarse-pointer devices, viewports ≤ 720 px, and software-rendered WebGL (SwiftShader/llvmpipe/etc.), in addition to the existing reduced-motion / save-data / low-memory / no-WebGL gates. | Phones got a ~3 s stall for a non-interactive decoration; software GL got 4–13 s. These visitors keep the static orbit artwork. |

Tried and reverted (no measurable benefit, so not shipped): importing `hasAtLeast` from `@/core/permissions` to keep zod out of the landing bundle (zod arrives anyway through the lazy Firebase chunk); `renderer.compileAsync` and `renderer.debug.checkShaderErrors = false` in the 3D scene (the ~1 s link stall just moved to the uniform query).

### Behaviour changes to be aware of

- **Phones and touch devices no longer get the 3D machine**; they see the static orbit art that was already the fallback. To revisit, relax the `pointer: coarse` / `innerWidth <= 720` lines in `machine-hero-loader.tsx` — but the stall measured above is why they are there.
- **If a `NEXT_PUBLIC_SENTRY_DSN` is ever set**, Sentry now loads as its own chunk right after the instrumentation file runs, instead of before it; an error thrown in the first few milliseconds of a page load could be missed. I could not check the production environment (names or values) to see whether a DSN is set there; the repo's health route says it is not.
- The count-up numbers on a server-rendered page start animating slightly later (after hydration) instead of on the first effect.

## 5. Before and after

**Deterministic results**

| | Before | After |
|---|---|---|
| First Load JS, shared | 137 kB | **105 kB** |
| `/` | 441 kB | **409 kB** |
| `/explore` | 441 kB | **409 kB** |
| `/f/[festSlug]` | 461 kB | **429 kB** |
| `/f/[festSlug]/e/[eventSlug]` | 480 kB | **448 kB** |
| `/sign-in` | 264 kB | **231 kB** |
| `/admin/[festSlug]/overview` | 265 kB | **233 kB** |
| JS actually transferred (sign-in, gz) | 547 kB | 513 kB (−34 kB) |
| JS transferred, landing on a phone | 709 kB | 510 kB (−199 kB: Sentry + no 3D chunk) |
| Firestore reads per fest-page render | 3 | **2** |
| Firestore reads per event-page render | 4 | **2** |
| Hydration error #418, throttled mobile `/f/<fest>` | 1/10 loads | **0/10** (8/10 with the Sentry change alone) |
| #418 on the event page | 0/10 | 0/10 |
| #418 on explore / landing (not measured before) | – | 0/10 · 0/6 |
| Landing, software WebGL: main-thread stall | TBT 4.1 s desktop / 8.7 s mobile | 0 ms / ~0.5–0.7 s (scene skipped) |
| Landing on a phone profile, real GPU | TBT 2.7 s | 0.6 s |

**Lab timings (median, noisy — see §1).** Public pages are within run-to-run noise of the baseline: desktop LCP 0.2–0.95 s before and after; mobile LCP 1.2–1.6 s on public pages, 2.4–2.9 s on `/sign-in`, 4.4–4.9 s on authenticated admin pages; CLS 0–0.002 throughout. I do not claim an LCP or INP improvement from these changes. Desktop landing on a real GPU is unchanged by design: TBT 546 → 751 ms is the same 3D start-up stall measured with different noise.

## 6. Verification on the final code

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eslint .` | same 1 pre-existing error + 2 pre-existing warnings as baseline; none in changed files |
| `npm test` | 25 files, **293 / 293** pass |
| `npm run test:emulator` | 13 files, **206 / 206** pass |
| `npm run build` | passes; route sizes as in §5 |
| Landing links (demo build) | all 10 links on the landing page return 2xx/3xx; "Register Your Event" → `/register-event` (the sign-in gate for visitors), "Explore Events" → `/explore` |
| Public pages & signed-in admin pages | the final measurement runs (public, real-GPU landing, authenticated) logged 0 console errors; the #418 hydration errors seen earlier are gone |
| Count-up animation | still runs (12 distinct intermediate values observed) and ends on the correct numbers |
| Sentry-lazy | the browser's chunk list on `/`, `/explore` and `/sign-in` no longer contains the Sentry SDK chunk (the remaining chunk matching "sentry" is Next's own client runtime) |

**Not run / not verified**
- Lighthouse, real-user Core Web Vitals, and anything against production or a Vercel preview deployment. The `cache()` dedupe, the lazy Sentry import and the count-up change were exercised only on a local `next start`; the repo's history includes a production-only crash on `/f/[festSlug]` that never reproduced locally, so these should go through a preview deployment first.
- Real mobile hardware, Safari/Firefox, and GPUs other than the one used.
- Sentry reporting end-to-end (no DSN available), and the two error boundaries (`error.tsx`, `global-error.tsx`) were not exercised in a browser after the change — only type-checked, linted and built.
- No browser-driven test of event registration, ticket display, QR scanning or certificate download beyond what the unit and emulator suites cover; those suites passed.

## 7. Regressions and unresolved issues

- No regression found by the checks above.
- The 3D machine still costs ~0.5–1.2 s of main-thread time at start-up on a desktop GPU (shader linking). It runs after the page has loaded, but it will show up in TBT/INP for desktop visitors.
- Items 5–8 in §3 are open.

## 8. Recommended next steps (impact ÷ risk)

1. **Cache the fest and event pages** (high impact, medium risk). Add `export async function generateStaticParams() { return []; }` to both pages so the existing `revalidate` takes effect. First stop a transient Firestore error from being cached as a 404 for 60 s: the `.catch(() => null)` currently turns *any* failure into "not found"; let real errors propagate (Next does not cache them) while keeping the intended 404 for missing/draft items (the draft-event query can be denied by rules, so test that case). Verify on a Vercel preview.
2. **Stop loading Firebase on pages that don't need it** (medium–high impact, medium risk): defer `loadAuthService()` to idle on public routes, or render the nav's signed-in state from a lightweight hint. ~140 kB gz of async JS on every public page.
3. **Render the `/sign-in` shell on the server** (medium impact, low–medium risk): keep the heading and tabs server-rendered and make only the form client-side; LCP is currently gated on 510 kB of JS.
4. **Server shell / skeleton for admin routes on mobile** (medium impact, medium risk): FCP ~4 s throttled.
5. **Cut the 3D scene's start-up cost** (low–medium impact, low risk): fewer distinct materials/shader programs, or start it on first scroll/interaction. Then reconsider enabling it on capable phones.
6. **Bound `/explore`** (low impact today, grows with data): `fests.listPublished()` has no limit; paginate or cap before the catalogue gets large.
7. **Image hygiene** (low impact): `public/logo.png` is 2.8 MB (1774×887). It is only served resized through `next/image`, but every optimizer cache miss decodes it, and `images.minimumCacheTTL` is at the default. A pre-sized copy plus a longer TTL would help; the original logo asset was deliberately left untouched here.
8. **Housekeeping**: `@supabase/ssr` has no imports; confirm and remove if unused.
