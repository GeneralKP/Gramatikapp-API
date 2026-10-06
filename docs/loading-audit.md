# Dashboard, study and authentication loading audit

Measured on 6 October 2026 by executing the real GraphQL schema locally against the configured MongoDB database. The existing account selected for the audit had 4,624 study cards. No account identifiers or content are saved here. These are backend operation times, not deployed browser page-load measurements.

| Operation | Before | After, two runs |
| --- | ---: | ---: |
| Dashboard, first request | 4,355–5,237 ms | 2,333–2,911 ms |
| Dashboard, subsequent request | 2,949–3,146 ms | 1,544–1,784 ms |
| Words, 50 due cards plus learning ahead | 3,911–4,134 ms | 1,389–1,434 ms |
| Words, 722 returned cards | 21,572–21,795 ms | 2,234–2,817 ms |

The large word response remained exactly 2,320,237 bytes in these live runs. The smaller queue varies slightly as learning cards become due. The audit uses `newLimit: 0` so it measures existing-card loading without allocating native introductions. It does not measure creation of new native pairs or provider/AI work.

The dominant word-session bottleneck was the nested GraphQL resolver pattern: 722 relation reads and 720 reads in each language collection, or 2,162 catalog queries. Bulk hydration now performs three catalog reads for this word-only queue. Both word and phrase queues, shared vocabulary entries, missing relations and missing endpoints retain their original response behavior. This follows Apollo's guidance on [eliminating repeated nested data fetches](https://www.apollographql.com/docs/apollo-server/data/fetching-data).

The due-card MongoDB query already uses `userId_1_nextDueDate_1`. Its execution plan examined 4,624 documents, returned 967 candidates and took 16 ms. Adding an index was not justified by these measurements: most elapsed time was repeated round trips, transfer and response construction.

## Further phrase, mixed and authentication audit

These measurements compare the first optimization above with the additional request-sharing/category changes, in the same local environment on 6 October 2026. They isolate the second round; mixed practice already benefited from bulk relation loading in the first round.

| Operation | Before second round, one run | After second round, two runs | Response size |
| --- | ---: | ---: | ---: |
| Phrases, 28 returned cards | 1,050 ms | 746–838 ms | 70,568 bytes |
| Mixed, 750 returned cards | 2,575 ms | 2,675–2,768 ms | 2,390,791 bytes |
| Phrase category, empty queue | 719 ms | 431–488 ms | 15 bytes |
| Mixed category, 475 returned cards | 3,154 ms | 2,733–2,891 ms | 1,537,149 bytes |
| Authentication + complete `Me` | 359 ms | 212–213 ms | 284 bytes |

The additional mixed changes reduce query dependencies but did not improve the unfiltered mixed timings in these runs. Its 2.4 MB response remains the main observable cost after removing per-card catalog queries. This is an inference from payload size and fast selection plans, not a measured split between CPU, transfer and browser rendering. No deployed-browser latency claim is made.

The phrase selection plan uses `userId_1_itemType_1_failureIndex_-1`, examines 266 documents and takes 2 ms. Mixed selection uses `userId_1_nextDueDate_1`, examines 4,624 documents and takes 15–29 ms. Token account lookup uses `_id_`; email login lookup uses the existing unique `email_1`. Both examine one document and take 0–1 ms. Category scans examine 4,152 Spanish words in 3–4 ms and 269 Spanish phrases in 0 ms. New indexes, server-wide caches and an aggregation rewrite were not justified by these plans; account/profile reads remain fresh on every request.

`dueItems` and `studyMoreItems` now share the authenticated account and scheduler profile instead of rereading users/settings/profile in sequence. Independent category lookups run together and allocation reuses their result. Counts load only the requested relation catalog and omit unused metadata. When pending cards fill the request, allocation skips the full reviewed-ID exclusion query. Creating new progress uses a single batch of unique-key `$setOnInsert` upserts, followed by a persisted read. Repeat/concurrent allocations retain existing schedules; only duplicate-key conflicts are tolerated, and other write/acknowledgement failures propagate. Native recognition/production conversion retains its existing transaction path. These allocation changes are verified with mocks; the live audit blocks writes and does not time them. MongoDB documents the [bulk-write ordering and error behavior](https://www.mongodb.com/docs/drivers/node/current/crud/bulk-write/).

Authentication now fetches only account fields, excluding `passwordHash` from token validation. `Me`, authorized own-user aliases and settings reuse that account within a request, while login still fetches and checks the password hash. JWT validation explicitly accepts the application's HS256 tokens and checks payload types before a database read. Signature, expiry, not-before and deleted-account checks remain enforced. No user or token is cached across requests.

In the browser, cached account data requires a token and corrupt cached JSON no longer prevents startup/logout. Authentication validation uses its captured token, avoids Apollo query deduplication/cache writes, and discards responses after cancellation or a token change. Logout clears Apollo data without refetching authenticated queries. The browser tests cover late logout/account-switch responses, expired tokens, offline validation, missing tokens and corrupt caches. This preserves offline access while leaving API ownership validation authoritative. Apollo describes [cache clearing at authentication boundaries](https://www.apollographql.com/docs/react/networking/authentication).

Dashboard counts and the learning path now share one projected progress read and one catalog snapshot per GraphQL request. Independent reads run together. The projection preserves scheduler, legacy Anki, update-time, burial and directional prerequisite inputs, while excluding large card text and mistake-history payloads. Account state never persists between requests. MongoDB documents [field projection](https://www.mongodb.com/docs/drivers/node/current/crud/query/project/) as the mechanism for returning only the required fields.

The browser previously waited for `Me` before mounting the dashboard. A saved signed-in account now starts dashboard data loading while the API validates its token. Reading metadata, refresh listeners and polling run only on Reading routes. API authentication and ownership checks remain in force.

No card prefetch was added. `dueItems` can create new progress and directional pairs, so speculative dashboard requests would introduce write behavior. Bulk loading removes the dominant delay while preserving the full 5,000-card request limit and existing local session behavior. The remaining large response is about 2.3 MB; transfer time on a slow connection still contributes to entry latency.

## Regression coverage

`npm run test:loading` in the API runs the real GraphQL schema and resolvers against mocked MongoDB responses, without any database connection. Complete JSON response fixtures were captured from API commit `fb32c3ed2488feca5e15aaf2fcb6bf6f047cf443` before the optimization. The tests compare nested catalog fields, card directions, serialized scheduler state, review choices, counts, category selection, extra practice, null relations and GraphQL error shape. They also cover a single-place native allowance, buried recognition prerequisites, legacy scheduling, unavailable cards, absent profiles, account isolation and bounded bulk-query counts. Versioned client operations keep the suite independent of a neighboring frontend checkout. Fixture changes require an intentional contract review. API CI runs loading and authentication regressions before publishing a backend release.

Additional complete phrase/mixed response fixtures were captured immediately before the second round. Allocation tests assert exact new-phrase fields/content/dates, one batched write, idempotent repeats, category reuse, the pending-queue shortcut and propagation of non-duplicate/acknowledgement failures. Mixed hydration also covers overlapping word/phrase relation IDs, and zero-limit requests keep their original early-return behavior. `npm run test:auth` runs actual JWT/bcrypt and GraphQL resolvers against mocked users/profile responses. It checks rejected tokens before database access, deleted accounts, normalized email login, wrong credentials, seven-day tokens, complete auth response fields, explicit zero/default allowances, bounded reads and cross-account query rejection.

`npm run test:loading` in the web repository uses mocked GraphQL responses with an intentionally held authentication response. It verifies that dashboard data begins during validation, Words/Phrases/Mixed open with the same card shapes and full queue limit, requests keep their card-type scope, and these paths do not request Reading metadata. `npm run test:auth` covers the browser authentication scenarios above.

Existing learning, exercise-entry, study-sync and session-completion suites protect scheduling, Undo, durable mistakes, retry/recovery and explicit AI generation boundaries. `npm run audit:loading` repeats the guarded read-only timing and query-plan audit; it bypasses index creation and blocks database writes.

The canonical standalone database diagram records these changes. Its collection inventory and original inventory audit date are unchanged. These measurements come from a local read-only audit; no deployment or production data mutation is part of the measurements.

Both production builds and TypeScript checks passed. Web lint passed with generated `.wrangler/**` files excluded; the default lint command has an existing `no-empty` error in a generated Wrangler temporary worker. No generated file or unrelated lint configuration was changed.
