# Known words

Holding Easy for 300 ms and sliding up selects Known. The option uses short English/Spanish/German labels. A tap still selects Easy; a hold released outside the popup cancels. Browser keyboard menus and native accessibility actions offer equivalent access.

Known applies to both active directions of the owned word, matched by sourceNoteGuid. It starts at 180 study days, the app’s six-month convention. The retained scheduler.knownInterval distinguishes this mature policy from ordinary Anki scheduling: Again removes the mature anchor and enters ordinary word relearning with an outstanding immediate retry, while Hard without an intervening Again retains the anchor, OK grows it by 1.5, and Easy grows it by 365/180. Known starts at 180 study days; its successful initial Hard/OK/Easy choices remain 180/270/365 days, while Again resets to the configured ordinary relearning step. Later successful ratings retain their new mature interval, with the existing maximumInterval cap. Known clears an optional Revisit reminder; Revisit continues to work on known cards. Words without the marker and all phrases retain their existing scheduling formulas.

The authenticated KNOWN review is one retryable MongoDB transaction. It preserves lifetime mistakes and writing reinforcement. Its reviewevents receipt charges zero new cards and keeps primary snapshots plus knownSiblings before snapshots and applied versions. Undo restores both directions only if neither has changed since that Known event; a later review or date edit prevents a stale overwrite. Reusing the same review ID does not apply it twice.

Each client persists the command and both predicted schedules before advancing, preserves the displayed new allowance for Known and Undo, and synchronizes before fetching replacements through the existing queue allocator. Refill errors retain the action and expose retry; fresh catalog content requires a connection. When every catalog word is known, the allocator reports no remaining introductions honestly.

## Verification

- Date simulations cover the 180-day return, all subsequent choices, mature growth after OK/Easy, discarding the six-month anchor after Again and returning to ordinary relearning, both DST boundaries, rollover and leap dates.
- MongoDB 8.0.34 replica-set fixtures cover zero quota even with a paused new budget, paired updates/Undo, retries, owner isolation, offline occurrence times and refusal to overwrite a newer sibling review.
- The real catalog allocator supplies four different new words in succession under a two-card allowance after Known, then reports finite catalog exhaustion.
- The browser’s authoritative scheduler fixtures preserve ordinary word outcomes and verify the additional Known preview. Gesture checks cover 320/390/1280px, taps, holds, slide selection, cancellation, keyboard selection, popup bounds, preserved counters and fresh-word refill.
- Manual Chrome checks against the isolated API/MongoDB show Known at six months, advance to another word with the allowance unchanged, and restore the original through paired Undo. Production data is excluded from all review tests.

The canonical model remains docs/database-model/index.html; historical inventory dates and counts are unchanged. Native build/runtime and final delivery evidence are recorded with the release after they complete.
