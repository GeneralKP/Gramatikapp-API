# Again retries stay in the current learning pool

Prepared locally on 15 October 2026. **Unreleased.** The owner clarified that an Again card should repeat immediately when it is the only card left, continuing until a different rating.

An ordinary AGAIN moves NEW to LEARNING, retains LEARNING, or moves REVIEW to RELEARNING. Each such review saves `userprogresses.againPending: true` with the ordinary versioned schedule and receipt. The card retains its shortened learning/relearning due date, but remains eligible in the red pool immediately while that retry is unresolved. This includes phrases with day-sized steps. No migration changes existing dates; missing flags default to false.

Web and native commit the review before requeuing one occurrence. They remove the consumed occurrence from the active batch, preserve the remaining batch and introduction pair, then include the retry in learning. When another card is ready, it gets a turn before the same failed card is selected for a new batch; a sole failed card repeats immediately. Unfinished retries remain in learning counts and prevent session completion/refill. A different rating clears the flag and resumes normal scheduling; explicit manual date deferral also clears it. Ordinary future steps after other ratings still wait for their due boundary.

The flag travels through compact selections, `schedule.state`, GraphQL `studyState`, generated client predictions, durable schedule snapshots and cache projections. Fresh counters and queue predicates use the same eligibility exception. Undo restores the previous flag and queue; lost responses retry the same review ID and version. A later server response cannot replace a newer retry state.

The app wrapper gives AGAIN a safe learning/relearning step if a deck has no configured steps, preserving the saved options and the classic Anki reference algorithm. Due-card Again resets the relearning baseline and subsequent previews. The initial phrase choices remain 7/30/180/365 days. Again also removes scheduler.knownInterval and resets a Known word to ordinary relearning. First Known still starts at 180 study days; successful Known Hard/Good/Easy retain their existing formulas until an Again. Suspension and burial still take precedence.

Review history, mistake counters, independent article counters and daily introduction allowances keep their existing meanings. Hard’s article action applies HARD and resolves an outstanding Again retry while incrementing the article counter. Temporary reminders keep all four ordinary recall ratings and their shared early-review rules; no Continue-only or five-year completion policy is included. No new command, collection or database index is added.

The canonical [database diagram](database-model/index.html) records the field, predicates, counters and recovery flow. Historical inventory counts and audit dates are unchanged. Native platform verification limits are recorded in the mobile `docs/verification.md`.

## Local verification

- `npm run test:again-pending`: repeated failures for new/learning/due words and phrases, non-Again resolution, empty step settings, phrase starting choices, temporary practice, manual deferral, availability and Known-anchor reset.
- `MONGODB_URI=mongodb://127.0.0.1:27043/gramatikapp npm run test:again-pending-integration`: disposable Mongo replica set; atomic review replay, Undo, ownership, compact Mongo account summaries and full-state counters, compact starter/hydration/GraphQL state and immediate queue selection. Fixtures are cleaned up.
- The article integration suite passes alongside these changes, including independent counters and Undo.
- API build, official Anki reference comparisons, word/phrase scheduling matrices and simulations were checked. The classic scheduler source remains unchanged.
- The standalone diagram was opened in Chromium; all seven affected views keep nodes inside their canvas without overlapping. It makes no app/API requests.

API `npm run lint` currently stops because the existing ESLint 9 setup has no `eslint.config.*`; this task does not change lint configuration. Client type/lint/test and native bundle results are recorded in their verification documents. Fresh native build/runtime limitations remain explicit there. No production mutation or release was used for verification.
