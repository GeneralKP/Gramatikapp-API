# Writing practice

The workbook at `/writing` creates Spanish-to-German exercises at all six CEFR bands, A1–C2. The learner chooses recent practice or difficult words, and may select specific difficult words before pressing Start Exercise. Vocabulary must be at or below the requested level. A1 uses up to two target words and one simple main clause; A2–C2 use up to four target words and one main clause plus one subordinate clause. Each language has 15–30 words. Clause audits list every finite verb, with one conjugated verb per clause; auxiliaries with infinitives or participles remain valid. New learners fall back to suitable catalog vocabulary. The model remains `gpt-6-luna` with high reasoning effort and strict structured output.

`generateWritingExercise(level, requestId, focus, wordIds)` saves the configuration and vocabulary snapshot and returns a persistent exercise URL. Existing callers default to `RECENT`; `DIFFICULT` prioritizes active difficulty across the user's entire studied vocabulary, rather than just the latest session. `difficultWritingWords(level, limit)` is an authenticated, read-only ranked list combining both card directions, excluding suspended/superseded records. Opening the page and browsing this list do not invoke AI. Request IDs also bind the level, focus and manual word selection.

`checkWritingTranslation(exerciseId, translation, requestId)` saves the learner's exact text, then checks meaning and German grammar. Correct answers receive one or two structured alternatives: a simple clause for A1, two clauses for A2–C2. Explanations are in Spanish. The German reference is hidden until an assessment completes. A completed assessment, including one with corrections, represents an exposure to the vocabulary; generating, reopening, failing to obtain feedback or rechecking the same exercise does not earn additional credit.

The first READY assessment atomically saves feedback and awards up to 0.25 `writingReinforcementCredit` per included vocabulary pair, to the available card with the highest remaining difficulty. Its timestamp and exact credits are recorded on the exercise. A MongoDB transaction and `reinforcementAppliedAt` prevent concurrent attempts/retries from awarding twice. No new collection is required. `failureIndex` remains the durable lifetime counter; active card difficulty is `max(0, failureIndex - writingReinforcementCredit)`, and word difficulty sums its active cards. New wrong Checks and Revisits raise `failureIndex` by one, so they also raise active difficulty. Schedules, source Anki counters and Undo behavior stay intact.

The input uses the device keyboard and declares German (`lang="de-DE"`) with spelling/autocorrection hints. The website cannot force the operating system to switch keyboard languages. The Spanish source stays beside the editor on desktop and uses a compact sticky panel on mobile. Enter submits; Shift+Enter inserts a line. Holding a Spanish word returns a contextual German dictionary hint, including the noun article when appropriate. Keyboard users can focus a word and press Enter.

`POST /api/translate` takes `{ "exerciseId": "...", "word": "responsabilidad" }` and a Bearer token. It returns a saved hint with `GENERATING`, `READY`, or `FAILED` status. `writingWordHint` polls the result. The GraphQL `translateWritingWord` mutation uses the same implementation and cache.

Every exercise, attempt, and hint belongs to an authenticated account. Unique request IDs, atomic claims and expiring job leases prevent duplicate provider calls after retries or concurrent requests. A failed operation can resume with its original ID. Drafts and pending commands are stored per account and exercise in the browser.

Checks:

- `npm run test:writing`: real MongoDB/GraphQL with a local provider fixture; no paid API call.
- `npm run test:writing-validation`: clause/finite-verb audits and regressions for malformed AI alternatives; no database or provider needed.
- `npm run test:writing-vocabulary`: real MongoDB tests for combined directions, historical difficult words, CEFR filtering, explicit selection and account isolation. `--unit` runs the level/formula checks without a database.
- `npx tsx scripts/testWritingLevelsLive.ts`: optional paid A1/A2/C2 generation and A1/C2 assessment smoke tests; refuses any database except the temporary local instance on port 27019.
- `npm run test:writing-browser`: real browser, API, MongoDB and REST endpoint with a provider fixture.
- `npm run test:writing-live`: optional paid Luna generation, assessment and contextual hint; temporary test records are cleaned up, with the sample saved outside Git.
- In the web repository, `npm run test:writing` covers native input, IME, source visibility, persistence, retries, hints and all module layouts at four widths in both themes.

# Vocabulary levels

`cefrLevel` stores A1.1 through C2.2. `cefrClassification` records model, version and classification date. These are estimated learning difficulty levels; they do not certify the learner's proficiency. `level` is synchronized to the same A1–C2 band. Card identities, schedules, review histories, and failure counts are preserved.

`npm run classify:levels` is a dry run; `npm run classify:levels -- --apply` classifies missing entries using Luna/high. It writes private backups and progress outside Git and can resume without reclassifying completed entries. `npx tsx scripts/testLevels.ts --verify-all` verifies every word and phrase. Dictionary search and level filters run across the entire catalog before pagination, using the German entry's level.

`npm run sync:levels` reports missing/conflicting legacy bands. `--apply` synchronizes them only when every entry has a valid detailed CEFR level, writes private EJSON backups (`LEVEL_BACKUP_DIR` may override the destination), and verifies that no other field changed. Classification now also writes the matching band. The independent, offline HTML entity-relationship model is [docs/database-model/index.html](docs/database-model/index.html); it describes the 15 application and four Anki archive collections.

Prompt version 3 uses 15–30 words. Saved version 1/2 exercises remain usable with their original 30–50 word assessment bounds.
Version 4 adds level-specific A1–C2 constructions and vocabulary selection.
