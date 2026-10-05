# Anki import and persistent mistakes

`UserProgress.failureIndex` counts wrong answer submissions for one user and one
card. It is independent of the difficulty rating and the scheduling fields.
`recordFailure(userId, itemId, attemptId)` increments the counter atomically and
stores the attempt ID in the same document, so retrying a request cannot count it
twice. All progress operations require the authenticated account to match
`userId`. Existing progress records default to zero; the importer also backfills
the persisted field.

The browser stores each pending attempt under its own localStorage key before
showing feedback. The queue survives route changes and reloads, retries when the
connection returns, and is scoped to the account. Undo restores answer feedback
and scheduling information through the `undoReview` database operation. Scheduling
and daily budgets are restored; the failure counter lives outside that snapshot.

`Word.failureIndex` sums the authenticated user's counters for that word's
relations. `mostFailedWords` groups both translation directions by their canonical
relation and sorts by the accumulated failures. It can supply vocabulary for a
future text lesson:

```graphql
query DifficultVocabulary($userId: ID!) {
  mostFailedWords(userId: $userId, limit: 20, minFailures: 3) {
    failureIndex
    wordRelation {
      main { word }
      translated { word forms { gender plural perfect past } notes examples }
    }
    cards { itemId failureIndex lastFailedAt card { direction } }
  }
}
```

## Import workflow

Run the updated backend before importing. Imported cards use `itemId` as the
card identity and `relationId` to resolve the shared vocabulary. Older progress
records continue to use `itemId` as the relation identity. An older backend that
does not understand `relationId` must be updated before using an imported account.

The exporter reads text-only `.apkg` files without executing any HTML or card
templates. Modern zstd packages require a Node runtime with built-in zstd
support (Node 24 works), plus Python 3. Field mappings and templates are validated;
unsupported note formats or media fail before database writes.

```sh
python3 scripts/exportAnki.py /path/to/deck.apkg /private/output
npm run test:anki -- /private/output/export.json
npm run import:anki -- --export /private/output/export.json --email ACCOUNT --timezone Europe/Berlin --output /private/output
npm run import:anki -- --export /private/output/export.json --email ACCOUNT --timezone Europe/Berlin --output /private/output --apply
npx tsx scripts/verifyAnki.ts /private/output/export.json ACCOUNT
```

The default import is a dry run. Applying saves an EJSON backup before writing,
preserves existing word metadata, and keeps different noun genders and noun/verb
lookalikes separate. Each Anki card gets independent progress. New card ordering,
intraday timestamps, and day-based due dates are distinguished. Calendar dates
use Anki's creation offset and the supplied current timezone, with the Anki day
rollover. Configuration parsing accepts both `KEY` and `key` column names and
rejects entries without a key. Duplicate legacy app progress is retained and
excluded from the due queue when the same relation is imported.

`ANKI_NOTES`, `ANKI_CARDS`, and `ANKI_REVIEWS` preserve every original row.
`ANKI_IMPORTS` preserves deck configuration, templates, field definitions, note
types, other metadata, the source hash, and the import manifest. Reapplying the
same completed package is a no-op. This is a one-time migration, not a continuous
sync with later Anki exports.

Anki `Again` events seed the failure index; Anki lapse totals are preserved
separately. Review ease, interval, due date, lifetime repetitions, and raw queue
state are retained. Legacy SM-2 helpers remain for compatibility. Production
reviews use the classic Anki-compatible scheduler described in
[ANKI_SCHEDULER.md](ANKI_SCHEDULER.md).
Run the scheduler migration after importing to apply the source deck settings
and preserve its learning/relearning states. FSRS remains disabled, matching
this source collection. The raw archive remains unchanged.

## Verification and rollback

```sh
npm run test:contexts
npm run test:anki
npm run test:failures
npx tsx scripts/rollbackAnki.ts /private/output/result.json
```

`test:failures` uses a temporary Mongo collection and removes it. `verifyAnki`
checks the imported rows against the original export, the German identities,
production GraphQL queries, account isolation, and mutations using temporary
progress records that it removes.

Rollback defaults to a read-only preflight. Adding `--apply` restores the backup
and removes the import. It refuses to proceed when an affected document has
changed since the import, so later review activity cannot be erased. Stop app
activity before applying a rollback. Personal deck data and snapshots belong in
a private output directory outside the repository.
