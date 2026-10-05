# Classic Anki scheduling and durable reviews

Production reviews now use the server's classic Anki-compatible state machine:
NEW → LEARNING → REVIEW, with RELEARNING after a forgotten review. Each
translation direction remains an independent card. The implementation was
checked against the official Anki 26.9.3 headless backend using synthetic cards;
Anki is a test oracle, not a production dependency.

The imported account uses its own deck settings: learning steps 10 minutes and
12 hours, relearning 1 day, graduating intervals 3/5 days, 40 new cards and 2000
reviews per day, a 4:00 Europe/Berlin rollover, and 20-minute learning ahead.
Source sibling burying is disabled. Today's imported study counts are retained
as a baseline. New app reviews add to those counts; reversed reviews do not.
Existing card dates and failure counts are preserved during migration.

## New-word introductions

Imported word notes introduce their two cards together: German → Spanish is a
reading card with a translation reveal and self-rating; Spanish → German then
requires typing the complete source expression, including its article and any
preposition. Due reviews may mix between these introductions. Learning timers
cannot insert a returning card between the two directions of a new pair.

The queue groups siblings by source note GUID and uses the original Anki new
position to order words. A complete pair needs two available new-card slots;
it waits when a batch or daily limit has only one slot left. Each direction
still consumes one slot and keeps its own Anki learning/review schedule.
Recognition that was introduced earlier unlocks its still-new production card,
including after reload; it is not reset or reviewed early to repeat the introduction.
A buried/suspended unseen recognition card cannot expose its reverse first.

The server rejects an out-of-order first production rating with
`INTRODUCTION_REQUIRED`; the client drops that obsolete command and refreshes
the queue. Bury-new does not hide the first production card after recognition.
Existing review sibling-bury rules continue to apply. Choosing Again on a
reading card records a durable failure, and Undo preserves that failure.
No imported positions, card content, review dates or history need rewriting.

Unseen native app words use the same pair rule. The existing production card
keeps its ID, schedule and failure count; an independent reading card is added
with source `APP`, linked to the same word relation. Noun gender supplies the
article when the stored German expression omits it. Pair creation uses stable
IDs and Mongo transactions, so concurrent requests/reloads cannot duplicate
cards. Newly fetched native words are paired automatically. Previously studied
native words keep their existing cards.

To prepare an account's existing unseen native words proactively:

```sh
npm run pair:native-words -- --email ACCOUNT
npm run pair:native-words -- --email ACCOUNT --apply
```

The apply run first saves a private EJSON backup, then checks that every original
production schedule and failure field is preserved. The source Anki file and
its cards are untouched.

## Reviews, retries and Undo

`reviewItem` accepts named `grade`, `reviewId` and `expectedVersion`. Named
grades are AGAIN, HARD, GOOD, EASY. Old clients can still send ratings 2..5 during
rollout, mapped to those grades. Only the named-grade path provides persistent
client retry IDs.

The Mongo transaction stores both the review event and its resulting scheduling
state. A repeated ID with the same payload returns the saved result. An ID
reused for another grade/card is rejected. Another tab cannot overwrite a newer
card state using an old schedule version. Conflict responses carry the current
card so the browser can refresh it and discard the obsolete pending command.

`undoReview(userId, reviewId)` restores the recorded scheduling snapshot,
increments the card version, and marks the event reversed. Its retry does not
reverse anything twice. A newer review of the same card must be undone first.
Failure counts, failure attempt IDs and last-failure timestamps are never part
of the restored snapshot. Mistakes remain recorded even when a rating is undone.

`reviewHistory` returns the app's review events, including reversed events.
Original Anki history remains in `ANKI_REVIEWS`; the import archive is immutable.

The browser saves pending ratings in account-scoped localStorage before sending
them. A lost response retries the same ID and grade. Reload replays outstanding
commands. A failed Undo leaves the local history available for another attempt.
Again/Hard/Good/Easy buttons show server-calculated next intervals. Keyboard
shortcuts are 1/2/3/4; Enter selects Again after an incorrect answer and Good after
a correct answer. During retry, other grades are disabled.

Learning cards return when due. Learning ahead is used after ready cards are
exhausted. The timer queues a card after the answer currently being typed, so it
cannot erase an unfinished answer. Future learning cards display their next
time instead of a false session-completion message. Due-card batches refill as
the session advances; daily limits remain server-controlled. Study More is an
explicit extra-practice operation and can include future cards.
It uses Anki's filtered-deck early-review calculations. Normal reviews use the
normal-deck calculations; the command retains this context during retries.

## Migration and rollback

```sh
npm run migrate:scheduler -- --email ACCOUNT
npm run migrate:scheduler -- --email ACCOUNT --apply
npm run migrate:scheduler -- --email ACCOUNT --rollback
```

Migration uses the archived source configuration, saves a private EJSON backup,
and updates only scheduling metadata. Compare-and-set writes skip concurrent
reviews and retry using their current state. Source queue state is used only for
cards that have not been reviewed in the old app; other cards retain their live
state and due date. Re-running a completed migration is a no-op.

Rollback is a preflight unless `--apply` is supplied. It refuses later study
activity or newly created progress records. It restores the scheduling metadata
and profile without changing failure counters. Keep backup files outside Git.

## Verification

```sh
npm run test:scheduler
npm run test:reviews
npm run test:new-words
npm run test:new-words-browser
npm run test:browser-server
# In the web project, with Vite running:
node scripts/testLearning.mjs
```

The synthetic fixtures exercise 2016 next-state comparisons (fuzz on
and off), plus 1008 applied-card queue/date checks from Anki 26.9.3. They cover
all four grades, learning/relearning, early and overdue reviews, high ease and
long intervals, empty learning steps, interval modifiers, and normal versus
filtered-deck early review. Local rollover and both daylight-saving boundaries
are checked separately.

The private migration verification also compared all four next states for each
of the 4125 imported cards with the official backend: 16500 matching answers.
All 4493 existing account progress records retained their due dates and failure
counts. Personal reference data and migration snapshots remain outside Git.

To regenerate fixtures, use an isolated Python 3.10+ environment containing
`anki==26.9.3`:

```sh
python scripts/generateAnkiParity.py scripts/fixtures/anki-classic.json --no-fuzz
python scripts/generateAnkiParity.py scripts/fixtures/anki-classic-fuzz.json
```

Mongo and real-browser integration tests create temporary account/progress
records and remove them. They exercise retries, ownership, stale tabs, Undo,
daily budgets, sibling bury restoration, durable failures, and the actual
Chrome → GraphQL → Mongo flow.

This change targets the imported deck's classic scheduling. FSRS, continuous
Anki synchronization, arbitrary template execution and media support are outside
this migration. The raw source is retained for future compatibility work.

References: [Anki deck options](https://docs.ankiweb.net/deck-options.html),
[Anki 26.09.3 scheduler](https://github.com/ankitects/anki/tree/26.09.3/rslib/src/scheduler),
[official headless package](https://pypi.org/project/anki/26.9.3/).
