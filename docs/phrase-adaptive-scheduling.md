# Adaptive phrase scheduling · 11 October 2026

The owner-selected first phrase options are exactly **7 days / 30 days / 6 months / 1 year**. These seed the shared adaptive word scheduler; established reviews continue growing rather than repeating four fixed intervals. This replaces the interim 7/11/14/about-30-day first options verified earlier on 11 October.

## Current policy

| State | Again | Hard | Good | Easy |
| --- | --- | --- | --- | --- |
| First phrase rating | 7 days, learning | 30 days, learning | 180 days, review | 365 days, review |
| First learning step after Again/Hard | 7 days | 30 days | 53 days, next learning step | about 365 days, graduating |
| Last learning step | 7 days | 53 days | about 180 days, graduating | about 365 days, graduating |
| Established phrase | 7-day relearning step | shared adaptive Hard | shared adaptive Good | shared adaptive Easy |

First options are exact and are not fuzzed, regardless of seed or deck graduation settings. Explicit maximum-interval caps remain authoritative. Good and Easy graduate immediately into REVIEW at 180/365 days; Again and Hard enter LEARNING. The shared engine averages the first two learning steps for Hard, so the phrase steps are 7/53 days: (7+53)/2=30. After Again/Hard, Good advances to the 53-day step and then graduates around 180 days. Subsequent learning graduation uses the word engine's deterministic fuzz around 180/365 days. Relearning retains the 7/14-day recovery steps and 21-day lapse floor. Mature growth uses the same ease, Hard/Easy factors, configured multiplier, early/late recall credit, review-count seed and interval cap as words. Identical mature word/phrase states receive identical successful growth; the longer phrase starting state makes equivalent successful phrase histories much longer. The preset is recomputed at each rating and the original stored deck options are retained. There is no multiplying the preset into itself on later reviews.

Again enters RELEARNING, reduces ease and increments lapses. Forgetting does not guarantee increasing intervals. Early filtered practice can retain or shorten a future schedule, and explicit maximum intervals can produce honest equal choices. On-time successful ratings grow until the cap. A bounded 21-day review baseline handles legacy short phrase schedules and the shared lapse-floor jitter is prevented from increasing that baseline after Again. Relearning Easy also respects small configured caps. Early review choices have a minimum of seven days, bounded by the explicit cap, so Hard cannot precede Again.

Intervals shown in days mean **calendar study days**, using the profile timezone and rollover (normally 04:00 Europe/Berlin). Six months and one year mean 180 and 365 study days. A seven-day option is due at that day's rollover, rather than exactly 168 hours after the button press. Calendar conversion keeps week-sized steps intact across DST. The date preview and saved receipt use exactly the same calculation.

No query, index, collection, wire field or migration changes in this follow-up. Existing due dates remain until an explicit rating. Ordinary reviews clear expired legacy temporary dates; future extra-practice completion retains the prior regular schedule. Idempotent command receipts, original occurrence times, version checks, durable mistakes, leeches and Undo remain supported. API, browser and native schedulers are generated from the same source. The owner authorized API/web deployment and mobile preview publication on 11 October 2026. Production progress was not synthesized or reset; release receipts record the published versions.

## Verification

- The exact-first-options regression failed first with 7/11/14/30 days versus the requested 7/30/180/365 days. The prior adaptive regression reproduced the old fixed mature 180-day plateau. Both pass with the current implementation.
- Seventy-two initial transitions verify all four exact starting intervals, visible 7d/30d/6mo/1y labels, deterministic seed independence, imported zero-history REVIEW normalization, custom graduation settings, two timezones, DST, original stored options, and eligibility one millisecond before/at due. Separate cap cases verify legitimate clipped equal choices. A newly introduced Good history grows **180→431→1,081→2,695→6,999→17,279** days with a fixed seed.
- The unit matrix checks 32 learning/relearning and 1,440 established transitions against the audited word engine configured with the long preset. It covers review histories, ease, early/due/late timing, two timezones, both DST boundaries, exact due eligibility, all grades, caps, stored-option stability and legacy temporary cleanup. First options ascend strictly; genuinely different delays retain different labels.
- A repeated successful fixture grows Hard **26→30→37→41→50→60**, Good **54→133→338→817→2,053→5,151**, and Easy **71→241→890→3,303→13,375→36,106** days. These are deterministic seed examples, not fixed product intervals.
- Three students from 10 April through 10 October study ten distinct phrases per active day. Successful and mostly Hard profiles each run 183 days/1,830 ratings; mixed runs 174 days/1,740 ratings with nine skipped days. All **5,400 ratings / 21,600 previews** agree across API/web/native code. No descending sets, entirely equal default-option sets or hidden distinct-label collisions occur. Successful Good history includes **180→451** days; only the earliest introductions reach a second due review within this six-month window. Longer repeated histories are covered separately with simulated future dates.
- An isolated loopback MongoDB replica set persists **75 actual phrase reviews** through `syncStudy`, across all ratings, early/due/late contexts, both DST boundaries, repeated successful histories, graduation, relearning and early practice with a ten-day cap. Every command is replayed; original dates, ease, intervals, history, leeches, versions and receipts remain consistent. Undo restores schedules and retains mistakes; stale versions cannot overwrite it.
- Real Chrome → local HTTP API → MongoDB: ten phrases show **7d / 30d / 6mo / 1y** on first reveal. Good persists exactly 180 days; their due Good round grows to **426–466 days**. All **20 receipts** retain their original previewed dates, with four distinct mature labels and tooltip dates matching the API. No phrase appears a minute before its first due time; service tests verify the exact millisecond boundary. The browser advances from 10 April through the six-month return. The API retains its real queue-count clock, producing the existing still-available guard during historical before-due checks. The earlier 40-receipt interim-preset run is historical and does not verify this policy.
- The iOS simulator renders all four exact first labels and completes an isolated two-phrase session. Its local service read confirms Good persists REVIEW at 180 study days, Hard remains LEARNING due in 30 study days, and an incorrect answer adds one lifetime mistake. Both native builds/exports and all 264 native tests pass; Android runtime verification is limited to startup. See the native verification receipt for signing and device limits.
- The original word scheduler still passes **2,016 official Anki 26.9.3 answer comparisons** and 1,008 applied queue/date checks. The explicit golden-fixture generator asserts all word outcomes remain byte-identical before writing updated phrase fixtures.

The [earlier interval audit](study-interval-audit.md) and [A1.1–C2.2 registry](study-level-audit/index.html) retain historical fixed-policy records. Their recorded phrase traces must not be interpreted as evidence for this new policy. Retrieval order and the reviewed query optimization remain unchanged by this scheduling follow-up.

## Run locally

```sh
npm run test:phrase-scheduling
npm run test:phrase-intervals
npm run test:scheduler
# Only the disposable loopback replica set on port 27019 is accepted:
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp npm run test:phrase-intervals-integration
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp JWT_SECRET=phrase-adaptive-local-test npm run test:phrase-student-browser
```

Client build and native runtime validation receipts are recorded in [mobile verification](../../german-gramatic-mobile/docs/verification.md). The canonical [database diagram](database-model/index.html) documents the preset, prediction and persisted transition without changing its production inventory snapshot.
