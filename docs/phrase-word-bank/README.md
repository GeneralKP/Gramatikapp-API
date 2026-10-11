# Phrase word-bank categories

Prepared locally on 11 October 2026. **Unreleased.** No production catalog or progress records were changed. The owner selected the existing flat bank, with grammatical ordering and a compact optional filter; the row/accordion alternatives are superseded.

Web and mobile retain one naturally wrapping tile bank without category headings, dividers or a separate scrolling viewport. The order is **Articles → Prepositions → Pronouns → Particles → Conjunctions → Verbs → Nouns → Adjectives → Adverbs → Numbers → Interjections → Punctuation → Other**. Words alphabetize within their earliest matching category. Several roles never duplicate a tile; the optional filter matches every valid role and alphabetizes its results. Repeated word occurrences remain separate selectable tiles. Tap, drag, removal and explicit word hints keep their existing behavior.

The inline **All words** control takes one tile-sized slot rather than a toolbar row. Web opens the browser's native select; mobile opens a dismissible category picker. All words is the default on each replacement bank. Using the last word in a filtered category immediately restores the full bank. Filtering changes local presentation only: it makes no API request, writes no progress and does not change the assembled answer or available tile identities. It adds no database structure change.

## Approved data structure change

The owner approved adding **NUMERAL** (Numbers: *zehn*, *drei*) and **PARTICLE** (Particles: *nicht*, modal *doch*) to the allowed grammatical categories. The existing `gramaticalCategories` array already supports several roles, for example `["ADVERB", "PARTICLE"]`. There are **no new database fields, collections or indexes** and no automatic backfill.

The study REST response adds optional `wordCategories`, a map from the exact cleaned word spelling to its category array. This is derived response metadata, retained in each client's existing derivative study cache; it is **not stored in MongoDB**. Old caches and unrecognized personal text still work using **Other**. Shared catalog metadata never includes user progress or private edits.

## Review and coverage

[coverage.json](coverage.json) records the dated read-only snapshot, every reviewed exception, category combinations and unresolved tokens. All **5,202 token occurrences in 269 German phrases** and **5,380 in 269 Spanish counterparts** resolve after applying the reviewed entries. No production data was rewritten. This checks the primary phrase catalog, not every standalone dictionary entry or arbitrary future text.

Stored phrase-linked word senses are preferred. Existing vocabulary arrays and already-READY surface categories supply most classifications. [The reviewed source registry](../../src/features/phrases/reviewedPhraseCategories.ts) fills missing numbers, inflected forms, proper names and particles. Legitimate overlapping roles are retained; this is lexical categorization rather than sentence parsing. The current practice bank assembles German words; the Spanish coverage check validates the counterpart catalog too.

The registry references [Duden's number words](https://www.duden.de/sprachwissen/fuer-lernende/wortarten-numerale), [IDS particles](https://grammis.ids-mannheim.de/systematische-grammatik/279), [IDS negation](https://grammis.ids-mannheim.de/systematische-grammatik/563), [RAE's dictionary](https://dle.rae.es/) and [ASALE's quiubo entry](https://www.asale.org/damer/quiubo/). To maintain it, review new missing forms, add their lexical roles, generate the shared helper and repeat the snapshot audit. Practice never invokes AI to assign a category.

## Retrieval and compatibility

An independent query subagent reviewed the implementation and existing indexes. The existing German word snapshot is reused; one narrow cached read supplies READY de→es surface `key/category`. The existing compound language/key index supports that read (1,119 examined/returned, 3 ms in the read-only audit). Catalog warmup and refresh are single-flight; surface translation saves immediately invalidate only the category projection, including uncertain commit/cleanup outcomes; the derived index is memoized by immutable snapshot identity. There is no per-tile query or new index. Word-only packets do not require this added lookup.

Hydrated phrases receive full metadata after personal text overlays. Pending manifest entries and mixed-session word distractors carry only first-token hints. Active refreshes retain the displayed text and its matching metadata. Selection order, scheduling, due dates, counts, allowances and durable review commands are unchanged. Browser pointer/tap interactions correspond to native pan/tap controls; both use the same generated ordering and filtering implementation and English/Spanish/German labels.

## Repeatable verification

From the API repository:

```sh
npm run test:phrase-grammar
npm run check:word-bank-grammar
npm run test:catalog-cache
npm run test:loading
npm run build
# Disposable loopback MongoDB only; never use production credentials:
MONGODB_URI=mongodb://127.0.0.1:27037/grammar-fixture npm run test:phrase-grammar-integration
# Explicit read-only catalog snapshot, with no users or progress:
npx tsx scripts/auditPhraseGrammar.ts /path/to/catalog-snapshot.json
```

The HTTP→Mongo fixture verifies personal edits, compact manifest hints, reload invalidation, query reuse and unchanged progress. Native tests cover metadata decoding/offline caching/active refresh, category order, duplicate identity, all-role filters, exhausted/new-bank reset, disabled controls, tap/removal and gesture regressions. Web `test:word-bank-sections` checks desktop, 390 px light and 320 px dark screens, including flat ordering, all-role filters, exhausted-filter reset, natural bank sizing and zero classification calls. Its existing `test:phrase-drag` verifies mouse/touch drag, insertion, cancellation and scrolling. Current native build/runtime receipts are recorded in the mobile [verification log](../../../german-gramatic-mobile/docs/verification.md).

The [standalone database diagram](../database-model/index.html) documents the approved enum values and the derived metadata flow, retaining its earlier dated inventory counts.
