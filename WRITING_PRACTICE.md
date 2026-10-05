# Writing practice

The workbook at `/writing` creates Spanish-to-German B2/C1 exercises using four entries from recent reviewed vocabulary, with a catalog fallback for a new learner. Each generated Spanish prompt and German reference has 30–50 words and one main clause plus one subordinate clause. The model is `gpt-6-luna` with high reasoning effort and strict structured output.

`generateWritingExercise(level, requestId)` saves the vocabulary snapshot and returns a persistent exercise URL. `checkWritingTranslation(exerciseId, translation, requestId)` saves the learner's exact text, then checks meaning and German grammar. Correct answers receive one or two alternatives. Explanations are in Spanish. The German reference is hidden by the server until an assessment succeeds. These exercises do not change card schedules or failure counts.

The on-screen QWERTZ keyboard is always shown beside the input. Enter submits; Shift+Enter inserts a line. Holding a Spanish word returns a contextual German dictionary hint, including the noun article when appropriate. Keyboard users can focus a word and press Enter.

`POST /api/translate` takes `{ "exerciseId": "...", "word": "responsabilidad" }` and a Bearer token. It returns a saved hint with `GENERATING`, `READY`, or `FAILED` status. `writingWordHint` polls the result. The GraphQL `translateWritingWord` mutation uses the same implementation and cache.

Every exercise, attempt, and hint belongs to an authenticated account. Unique request IDs, atomic claims and expiring job leases prevent duplicate provider calls after retries or concurrent requests. A failed operation can resume with its original ID. Drafts and pending commands are stored per account and exercise in the browser.

Checks:

- `npm run test:writing`: real MongoDB/GraphQL with a local provider fixture; no paid API call.
- `npm run test:writing-browser`: real browser, API, MongoDB and REST endpoint with a provider fixture.
- `npm run test:writing-live`: optional paid Luna generation, assessment and contextual hint; temporary test records are cleaned up, with the sample saved outside Git.
- In the web repository, `npm run test:writing` covers keyboard, persistence, retries, hints and all module layouts at four widths in both themes.

# Vocabulary levels

`cefrLevel` stores A1.1 through C2.2. `cefrClassification` records model, version and classification date. These are estimated learning difficulty levels; they do not certify the learner's proficiency. Existing `level`, card identities, schedules, review histories, and failure counts are preserved.

`npm run classify:levels` is a dry run; `npm run classify:levels -- --apply` classifies missing entries using Luna/high. It writes private backups and progress outside Git and can resume without reclassifying completed entries. `npx tsx scripts/testLevels.ts --verify-all` verifies every word and phrase. Dictionary search and level filters run across the entire catalog before pagination, using the German entry's level.
