# Study interval audit · 10 October 2026 · unreleased

> Historical audit of the earlier fixed phrase policy. The owner subsequently requested adaptive phrases with a seven-day first-step minimum. See [the current local implementation and verification](phrase-adaptive-scheduling.md). Recorded results below retain their original policy and dates.

## Findings and prepared fixes

The API owns the scheduler. Web and native run generated copies for previews and durable offline commands; the server replays the same transition at the command's original occurrence time. Word scheduling matches the retained official Anki fixtures. Previewed due dates and persisted due dates agreed throughout this audit.

Three presentation defects were reproduced and fixed locally:

1. **Completing Revisit showed misleading identical choices.** The extra review deliberately preserves the regular interval, ease and due date. Again, Hard, Good and Easy therefore all returned that same regular date, while another Revisit could schedule tomorrow again. Completion now offers one **Continue** action, represented by the existing GOOD command, with an explanation that the regular date is retained. The separate Revisit control remains available to repeat extra practice tomorrow when that precedes the regular review. Older pending grades still replay compatibly. If the regular review has become due, ordinary ratings return.
2. **Rounding could hide different intervals.** For example, 361, 365, 366 and 370 days could all appear as `1y`. Both clients now use one generated presentation helper; colliding compact labels fall back to exact days or mixed short units. Truly equal schedules remain equal. Revisit appears on a separate extra-practice row so its one-day delay is not presented as a fifth, longer recall rating.
3. **An open feedback bar could become stale.** Advancing the clock until the regular review became due left the old completion action on screen. Both clients recalculate active-card previews each second while feedback is open. Chrome and native component tests cover the date boundary.

These are prepared source changes. Nothing was deployed, published, reset or migrated in production. The canonical [database/data-flow diagram](database-model/index.html) documents the changes; its inventory and audit dates are unchanged.

## What the current algorithms actually do

**Words:** Again repeats a learning step or enters relearning. Hard normally grows an established interval by approximately 1.2 and reduces ease. Good uses the current ease (initially 2.5); Easy adds its configured bonus and increases ease. Deterministic fuzz, overdue days, early-study context and configured maximum intervals also matter. Lifetime review count supplies the fuzz seed; it is not a linear growth multiplier. A successful sample progressed through Good intervals of **1, 4, 9, 21, 56 and 139 days**. Lapses and early practice can legitimately reduce or retain an interval even while lifetime reviews increase.

**Phrases:** New phrases use the same learning steps as words. Once established, the application overrides the Anki transition with fixed **7 / 30 / 180 / 365 days** for Again / Hard / Good / Easy. These are ascending, but they never grow with review count. Phrase Again does not enter the word relearning path. The initial learning-to-established transition can therefore jump from a one-day graduation to a 180-day Good review. This is existing product policy, not an adaptive extended version of word scheduling; the audit preserves it and adds explicit regression coverage. An adaptive phrase policy would be a separate behavior change.

**Equal ordinary times can be valid:** Learning steps crossing the 04:00 local rollover become the same next study-day boundary. Configured caps can make Hard/Good/Easy equal. Early reviews can also converge. The tests distinguish these real ties from rounded-label collisions and Revisit completion. Artificially separating these schedules would break the configured scheduler.

## Do the displayed times get respected?

The authoritative value is each option's `nextDueDate`. Selecting that option at the tested occurrence time produced exactly that date in the local prediction, transaction and review receipt.

- Minute labels show the nominal learning step. Anki adds deterministic jitter: at most 25% of the step, capped at five minutes. A `10m` step can thus be due up to roughly 12.5 minutes later. This behavior was preserved.
- Day/month/year labels express study-day intervals, starting at the account's local 04:00 rollover. `1d` is the next study-day boundary, not a promise of exactly 24 elapsed hours. DST can change elapsed hours. Web button tooltips expose the preview's actual local due date/time.
- The default **20-minute learn-ahead window** allows a short-step card to reappear early once ready reviews/new cards are exhausted. Its stored due date remains unchanged. Seeing it immediately again can therefore be deliberate queue behavior rather than a scheduling write error.
- Revisit's extra-practice due instant is exactly 24 hours after selection; its regular schedule remains separate. Integration tests reject eligibility one millisecond early, then accept it at the due instant.
- Review commands persist their original occurrence time. Lost acknowledgements replay the same identity; stale versions cannot overwrite a newer schedule. Undo restores the scheduling snapshot while retaining lifetime mistakes.

## Six-month and integration evidence

The deterministic simulated student starts **10 April 2026** and is checked daily through **10 October 2026**: 183 calendar days. Each active session selects **10 distinct word cards**, plus at most three phrases, and completes short learning repetitions during a bounded two-hour session. The available new-card pool ensures daily word practice. No synthetic identity or progress is sent to production.

| Profile | Study days | Missed days | Word ratings | Phrase ratings | Option previews | Largest word interval |
|---|---:|---:|---:|---:|---:|---:|
| Successful, Good | 183 | 0 | 2,171 | 33 | 10,305 | 274 days |
| Mixed recall | 174 | 9 | 2,159 | 40 | 10,312 | 343 days |
| Mostly Hard | 183 | 0 | 2,075 | 87 | 10,338 | 46 days |

Across **6,565 ratings and 30,955 previews**, ordinary choices never descended, no default ordinary set was entirely equal, and distinct delays never had identical rendered labels. Web/API/native predictions matched. The larger mixed-profile maximum reflects different ease/answer/overdue histories, not simply a larger review count.

A smaller six-month mixed student with 50 word cards and 10 phrase cards replayed **604 reviews** through the actual sync service and MongoDB replica-set transactions. Its smaller pool produced 145 nonempty study sessions and nine skipped days. Every saved date, phase, interval, ease, repetition/lapse count and version matched the prediction. Tests replayed command batches to simulate lost acknowledgements, then separately exercised Revisit eligibility/completion, Undo, durable mistakes and stale versions.

A real Chrome student walkthrough also reviewed 10 words on 10 and 11 April against the local HTTP API and MongoDB. Advancing 15 minutes completed the learning steps, then advancing one day exercised the due reviews. All 30 original-time receipts were stored, all 10 cards graduated, intervals grew and no mistaken answer was recorded.

The isolated database runs on **127.0.0.1:27019**. The integration script refuses any other URI. This matters because the API internally selects the `gramatikapp` database name: changing only a URI's database suffix would not isolate production tests. Fixture records are removed in `finally`.

The designated existing live account was signed into on the hosted web app. Fresh word and phrase starters each contained 20 NEW cards with `[1, 10]` learning steps; words showed **Again 1m / Hard 6m / Good 10m / Easy 5d** for that card's deterministic seed. Phrase policy was inspected through its loaded contract and local integration fixtures. The live walkthrough blocked review/settings/edit mutations, submitted no review, failure, edit or settings mutation and created no additional account.

## Reproduction

From the shared workspace’s API repository (the simulation checks the adjacent generated web/native copies):

```sh
npm run test:study-intervals
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp npm run test:study-intervals-integration
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp npm run test:study-student-browser
node scripts/generateBrowserScheduler.mjs --check
npm run test:scheduler
npm run test:study-scheduling
```

The student browser command also requires local Vite on port 5173, the API on port 4000, and the same local fixture JWT_SECRET as that API process. It aborts non-loopback API requests.

The integration command requires an already initialized disposable Mongo replica set on port 27019. Do not substitute a live database URI.

From the web repository, with local Vite running:

```sh
npm run test:study-intervals
npm run test:study-previews
node scripts/auditStudyIntervalsLive.mjs
```

The optional live audit reads the private designated credentials file, signs into the existing account and inspects controls without selecting a rating. The responsive local browser regression covers one completion action, keyboard guards, time passing, separated extra-practice controls and generated local predictions.

Native component/data tests cover the same completion and elapsed-clock cases; strict client checks and native bundle verification are recorded in the mobile `docs/verification.md`. Native runtime verification limits must be read separately from successful JavaScript exports.

## Phrase-specific follow-up · 11 October 2026 · unreleased

The added tests confirm shared NEW/LEARNING/RELEARNING transitions, including custom learning steps and rollover, in **48 comparisons**. A separate **1,440-transition** matrix checks all established grades across prior intervals, lifetime review counts, ease, early/on-time/overdue reviews, Berlin/New York clocks and rollover. Preview dates match applied dates; choices are strictly ascending with distinct labels. Both Berlin DST boundaries and exact queue eligibility one millisecond before/at due are covered.

The proposed “same algorithm, just longer intervals” assumption fails for established phrases. Repeating each grade six times gives **Again 7→7→7, Hard 30→30→30, Good 180→180→180, Easy 365→365→365**. Phrase Again stays in REVIEW, retains ease and increments lapses; word Again enters relearning. Mature word Good can exceed phrase Good. Word interval multipliers and maximum intervals do not affect the established phrase override. These are explicit characterization tests of existing behavior, not evidence that adaptive phrase growth is implemented. The fixed interval policy was retained. A new regression exposed a stale temporary-date cleanup defect: once the regular phrase review was due, a legacy temporary date could mask all four newly selected future dates. The API now clears that field on ordinary established phrase reviews; both generated clients use the same fix. A future regular date still retains the existing one-action extra-practice completion behavior. This fix remains unreleased.

Three phrase-only students select **10 distinct phrase cards per active day**, with learning repetitions, from 10 April through 10 October:

| Profile | Active days | Phrase ratings | Option previews | Established grades exercised |
|---|---:|---:|---:|---|
| Good recall | 183 | 2,740 | 10,960 | Good |
| Mixed recall, nine missed days | 174 | 2,486 | 9,944 | Again, Hard, Good, Easy |
| Mostly Hard | 183 | 2,164 | 8,656 | Again, Hard |

All **7,390 ratings / 29,560 previews** matched API/web/native scheduler code. No ordinary set was entirely equal and distinct delays never collapsed to identical labels. Good on a traced phrase progressed **1→180→180 days**, exposing the fixed plateau after shared learning graduation.

An isolated replica set persisted **55 additional phrase reviews** through the actual sync service: every grade, early/due/overdue context, both DST boundaries, repeated due reviews and initial graduation. Every command was retried; receipt identity, original time, saved interval/date/ease/lapses, schedule versions and lifetime mistakes remained consistent. Undo restored the schedule while retaining failures; stale commands were rejected. Shared leech accounting and unavailable phrase Revisit were also checked. Four legacy stale-temporary cases verify each grade saves its distinct future date, unsets the old temporary field and can restore the original snapshot through Undo.

The Chrome phrase student uses the real local HTTP API and MongoDB. It completes two learning reviews per card, advances one day to the fixed Good review, then advances 180 days to review the same ten phrases again. It verifies all four displayed established-rating labels and actual date tooltips, absence of Revisit, absence before the regular due time and availability at due. All **40 phrase receipts** agree with previews at their original occurrence times; repeated Good stays at 180 days. Service tests establish the exact millisecond boundary; Chrome checks a minute before due so UI hydration timers can continue normally. The API queue-count clock remains today's real time: before the browser's historical due date, this deliberate clock skew produces the existing “Cards are still available” guard. No phrase renders or review is created until the browser clock reaches due. Review writes still use the original simulated occurrence time.

Reproduce from the API repository:

```sh
npm run test:phrase-scheduling
npm run test:phrase-intervals
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp npm run test:phrase-intervals-integration
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp npm run test:phrase-student-browser
```

The browser command needs the same local API/Vite/JWT setup described above. Phrase unit tests also run within `test:scheduler`, which is covered by API CI. Client parity here is scheduler-source execution, with web/native type checks, all 261 native tests and the 25-case web golden suite passing; no new native device walkthrough or binary was produced in this follow-up. The web golden suite includes a legacy stale-temporary phrase and shared leech suspension on Again. Everything remains local and unreleased.
