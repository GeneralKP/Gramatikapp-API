# Practice feedback and schedule audit — 8 October 2026

Client/API source changes are unreleased. The owner separately approved one production data repair for Waggon; no deployment, push or mobile release was performed.

## Waggon

The APP-only Spanish → German card retained a legacy interval of one day, one repetition, last-reviewed date **27 February 2026** and due date **28 February 2026**. The older updater wrote these fields when receiving a rating, but it did not retain review receipts. New-card creation initialized a zero interval and null last-reviewed date. The later scheduler/content migrations preserved the existing schedule rather than creating February review history. We cannot establish whether an intentional review, an old client error or other legacy activity generated that state.

Today’s modern receipt confirms a **Hard** rating and then **Undo**. Undo restored the February schedule. Mistakes are lifetime attempts and remain after Undo, explaining the recent `lastFailedAt` beside an older `lastReviewed`. Anki’s ordinary overdue bonus applied to that saved REVIEW state, yielding the large Good/Easy previews; past due dates themselves are valid.

The supplied APKG contains **2,067 notes, 4,125 cards and 43,052 review records**, but no Waggon / “el vagón” note. It cannot validate this APP-only history.

After explicit owner confirmation, `restartLegacyStudyCard.ts` restarted this one card at **20:11:26 UTC**: NEW, interval/repetitions/lifetime reviews/lapses zero, initial ease, null last-reviewed date and due now. Schedule version advanced from 2 to 3. Card content, mistake count **2**, failure identities/timestamp and the undone receipt were retained. A private, lossless BSON backup preceded the write. A fresh read verified the state and initial learning options. At the evening audit, Again was 10 minutes, Hard/Good crossed the Berlin 04:00 rollover and displayed one day, and Easy was five days. No rating or synthetic practice event was written to validate the repair.

## Wider read-only audit

- All **4,125** Anki card IDs matched their original note GUIDs and template ordinals.
- **19** NEW Anki due values are queue positions, not calendar dates.
- Of **4,106** calendar schedules, **4,102** match the supplied export; all four different dates and their phases exactly match their current app review receipts.
- **408** export histories differ from the original retained import archive. Against that original archive, no unexplained live-history difference was found for cards without active app reviews. Due-only reconciliation intentionally preserved the archival history and review counters.
- The initial **4,667-record** audit found no invalid dates and two zero-history REVIEW snapshots. These have no last-reviewed date, interval, repetitions, lifetime reviews, lapses or archived review count. The prepared shared guard derives them as NEW, preserves manual future deferrals, and avoids erroneous overdue bonuses. It does not write on read. This source fix requires a future approved deployment/release.
- After Waggon’s restart, **12** other APP-only legacy histories have no receipt proving their old last-reviewed timestamp. Absence of a receipt is not proof that they were never studied; none was reset.

`auditPracticeScheduling.ts` reads raw collections and the local export without initializing indexes or progress. It stores a private report and does not write to MongoDB. `restartLegacyStudyCard.ts` defaults to dry run, targets one progress ID, requires explicit unstudied confirmation and a reviewed version for apply, rejects Anki/modern active history, and aborts concurrent schedule changes. It is a maintenance tool, not a client API or bulk-reset policy.

## Shared client behavior

Both clients show aligned submitted/correct text with exact changed-letter backgrounds, neutral insertion/deletion gaps and an underline cue. Visible answer headings are removed; English/Spanish/German labels remain for screen readers. NFC normalization accepts equivalent composed/decomposed umlauts. Loaded notes/examples remain local to Reveal, with no new request.

Word/phrase production has one Show answer control; recognition keeps Show Spanish translation. Check records an idempotent mistake before feedback, and rating separately records the scheduling command. The card editor is in the header beside Previous card. Navigation icons match the supported web/native destinations.

German WORD production automatically focuses its input. Recognition and phrases do not. Native Android keyboard avoidance keeps Show answer above the keyboard; iOS retains padding avoidance. Browser autofocus is equivalent focus behavior, though mobile browsers can restrict programmatic software-keyboard opening. No physical-phone keyboard claim is made.

Legacy missing lifetime-review counters use the same zero default in API normalization and the client contract; any nonzero interval, repetition, lapse, archive count or last-reviewed date prevents automatic recovery.

The versioned [database diagram](database-model/index.html) documents these transitions and the single confirmed repair without changing its inventory snapshot date.
