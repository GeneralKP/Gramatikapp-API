# Dashboard and practice startup · 9 October 2026

The 1.3.1 dashboard loaded thousands of progress records to derive a few totals. Mixed practice requested every selected card's rich content before showing its first card. Native startup also awaited a derivative card-cache file before starting its online request. Together these made large accounts slow despite correct scheduling.

The shared API now computes known scheduler counts and graduated relation identities inside MongoDB. Compact legacy records still use the existing Anki compatibility code. Summaries are shared only within the current request; dates and eligibility stay fresh. Context, card type, suspension, burial, temporary due dates, per-card learn-ahead, new-card quota and mastery semantics are retained. Prepared study packets keep their existing calculation path. No collection, field, index, saved due date or review history changed.

Both clients request `cardLimit: 24`, retaining the complete selected manifest and the original due/new limits. They hydrate the remainder in 100-card batches, prioritizing the actual adaptive queue so a learning card outside the starter can become ready first. The active card does not change when background content arrives. Reveal uses loaded content. The study read routes negotiate gzip/Brotli; auth, GraphQL and mutation routes keep their existing response behavior.

Native startup still awaits the primary pending-command journal and reconciliation. Optional card-cache reads run alongside online loading. A late cache cannot replace a verified network response; offline failure awaits the saved cache before reporting empty/error. Saved commands, conflicts and retries retain their existing semantics.

## Evidence

- Read-only comparison on an existing large account (4,667 progress records): the measured database-read phase fell from **11,527 ms / 1,575,050 bytes** to **2,711 ms / 326,856 bytes**. Graduated relation identities and legacy fallback identities matched. This is a database-phase comparison, not a physical-phone screen timing. Collection writes were blocked during the comparison. No personal account was used for authenticated testing.
- Disposable MongoDB 8 fixture: 4,000 reviews originally transferred **2,706,748 bytes** in dashboard database replies; the optimized path transfers **248,041 bytes**. The performance regression fails on the original implementation and passes after the fix. Mixed legacy/known phases and scoped counters equal the original prepared calculation.
- Actual local Express HTTP test: a 4,000-card response shrinks from **3,106,253 bytes** to **89,036 bytes** with gzip. The starter's gzip response is **87,785 bytes**, including the full manifest. Decoded packets, counters, schedules, flags and cache headers match. These synthetic measurements are reproducible; they are not production wire measurements.
- Native regressions hold a cache read while checking that the 24-card network request starts, reject stale late cache replacement, preserve offline fallback, and prioritize a tail learning card while retaining its active identity.

Run `npm run test:dashboard-performance` against loopback MongoDB 8. The test creates and drops only its own `dashboard_performance_tests_<pid>` fixture database and rejects non-loopback targets. `npm run test:loading` covers the original scoped loading contracts. Web progressive/loading/sync tests and native verification are recorded in the mobile [verification record](../../german-gramatic-mobile/docs/verification.md).

Authenticated live reads used only the designated existing test account. Practice UI uses the memory-only QA server; no production synthetic cards, ratings or exercise generation are created. Existing production records were not repaired or rescheduled by this task.

The canonical [database diagram](database-model/index.html) documents the fresh summaries, complete manifest and native cache race. Historical inventory counts and audit dates remain unchanged. API build passes; its pre-existing ESLint 9 configuration lacks `eslint.config.*`, so no API lint pass is claimed.

The owner explicitly requested publication of these prepared API, web and mobile changes on 9 October 2026. The mobile release is 1.3.2 / native build 6. Deployment readiness and immutable APK results are recorded in the mobile verification record; publication does not run the Anki maintenance tools or rewrite saved schedules.
