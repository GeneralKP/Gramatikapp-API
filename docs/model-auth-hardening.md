# Model cleanup and authentication hardening

Prepared 15 October 2026. **Unreleased**; no production data or deployment changed.

## Cleanup and compatibility

Repository-wide references showed no callers for `dailyNewLimit`, `counterSummaryPipeline`, `counterEligibility` or `isDue`. These helpers and unused imports were removed. TypeScript now rejects unused imports, locals and unmarked parameters during the build. Phrase GraphQL serialization now has one implementation, and authentication uses the existing shared default settings instead of a second copy. HTTP application construction is separate from database/catalog startup so the real transport can be verified independently.

All collection handles, persisted progress fields, imported Anki metadata, indexes and enum exports still have consumers. They remain part of the model. This first pass retained the legacy `calculateNextReview` export for two tooling tests; the [subsequent model/resolver audit](model-resolver-audit.md) replaces those tests with production imported-scheduler coverage and removes that otherwise uncalled module. The ignored legacy review argument remains compatible with positional callers. No database migration or deletion is required.

Characterization tests were run before refactoring. They preserve phrase/word content, IDs, missing/null explanation handling, dates, ordering, directional scheduling, quota defaults, ownership and existing authentication responses. Catalog diagnostic requests from both shipped importers use valid page sizes.

## Request policy

Counters are process-local fixed windows with bounded storage and lazy expiry. A full identity store rejects new identities until capacity expires. There is no timer per visitor or waiting queue. IPv4-mapped IPv6 addresses share their IPv4 bucket; IPv6 privacy addresses share a /64 bucket. The API trusts forwarding information only from loopback, matching its direct Caddy peer. Caddy must keep replacing untrusted incoming forwarding headers and the API must retain its loopback bind.

| Boundary | Limit | Rejection |
| --- | --- | --- |
| HTTP ingress, before JSON parsing | 600 requests/minute/address, 1,200/minute/process, 64 active requests | HTTP 429, `TOO_MANY_REQUESTS`, `Retry-After` |
| Socket/header/body reception | 256 connections; headers 10 seconds, request reception 30 seconds, idle keepalive 5 seconds | Node closes/rejects incomplete requests |
| GraphQL source/parser | 64 KiB source; 5,000 tokens | HTTP 413/400 before Apollo validation |
| Expanded GraphQL structure | 1,000 selections, depth 16, 40 root fields, 100 selections in a raw set | HTTP 400, `BAD_USER_INPUT` |
| Authentication | One login/register field per operation, including aliases/fragments; 10 attempts/minute/address and 120/minute/process | HTTP 400/429; retry delay on throttling |
| Password computation | Two active hashes/comparisons per process, no pending queue | HTTP 429, retry after one second |
| Anonymous public catalog work | Two catalog roots; no more than two occurrences of a field per merged parent object; 30 requests/minute/address, 300/minute/process, four active operations | HTTP 400/429 |
| Direct catalog list bounds | Integer limit 1–500; nonnegative integer offset; existing defaults retained | Validation before MongoDB access |

Structure is checked before schema validation, including unused operation/fragment definitions, and again for the selected operation through Apollo's plugin. This protects both validation and cached-document execution. Anonymous nested alias limits share counters across fragments and repeated parent response keys; authenticated equivalents retain the normal structural budget. Anonymous catalog slots release when Apollo finishes, so a caller disconnect cannot create extra database work. Health runs before JSON parsing and remains available during throttling. HTTP batching remains disabled and CSRF prevention is explicit.

Malformed JSON and oversized bodies return short JSON errors without echoing input or stack traces. The general body cap remains 2 MiB for imports/sync. Rate-limit identity comes from the trusted peer chain, not arbitrary header prefixes or a bearer token's mere presence. Limits are initial policies for this single API process; additional replicas need a shared limiter or equivalent proxy enforcement. Application limits do not establish immunity to network saturation.

## Credentials and clients

Malformed credentials fail before account queries. Email is a nonempty string of at most 320 characters; registration requires a simple address shape, while login preserves existing lowercase matching and legacy address formats. Registration retains its six-character password minimum. Password whitespace and Unicode remain significant. Bcrypt receives the first 73 UTF-16 units, preserving its effective first 72 UTF-8 bytes even across surrogate boundaries; existing long-password hashes still verify. Tokens exceeding 8 KiB fail before JWT verification/account lookup. Existing seven-day HS256 tokens, ownership checks and password-hash projection remain unchanged.

Native transport now preserves validated GraphQL messages/codes on failed HTTP responses, with REST `error` messages taking precedence. Both clients show rate-limit failures, retain sessions on 429, reenable the form and retry only after an explicit user action. HTTP 401 remains the session-invalidation boundary. Web product code needs no change; it gains the equivalent browser regression suite.

## Verification

`npm run test:model-refactor` covers the original response contracts plus valid/default pagination and 60 invalid literal/variable cases. `npm run test:auth-security` covers credentials, real bcrypt compatibility/concurrency, bounded counters, actual HTTP admission, parsing/aliases/fragments, cached operations, anonymous query lifecycle/disconnects and current web/native documents. New security tests were first observed failing on the missing behavior. Existing API CI verification runs against owned loopback MongoDB fixtures; no synthetic identities or progress are written to production.

Client evidence and exact verification limitations are recorded in the companion mobile `docs/verification.md` and web `docs/auth-hardening.md`. CI runs both new API suites before deployment packaging. The standalone [database/data-flow diagram](database-model/index.html) includes this review; its historical inventory date and counts remain unchanged.

## Final local results

- All 35 API verification commands exited successfully, including the existing CI verification, transaction fixtures, response contracts, pagination/model tests and 15 deployment-controller Python tests. Complete command/environment/output records are in ignored `artifacts/model-auth/ci-verification.log`.
- Final build and `test:auth-security` pass after the additional IPv4-mapped IPv6 normalization regression. Both new API suites are registered in CI.
- Mobile: 44 suites / 372 tests, strict types/lint, 26 tooling tests and both Hermes exports pass. Web: eight new and six existing authentication scenarios, localization, build/lint/types and four CI-runner tests pass. Its new security suite runs in the foundation shard (26 browser commands across six shards).
- The full mobile pass included unchanged reruns after existing Reading/PracticeFlags timing failures. An independent focused repeat also hit the new login UI test's five-second deadline during observed contention from an unrelated native export; the unchanged rerun passed 13/13. No assertion or deadline was weakened. Exact test names and limitations are retained in mobile verification notes.
- All eight diagram views render with valid nodes/edges; its 390-pixel layout has no body overflow. The final page has no console errors, API/provider calls or remote requests. Historical snapshot counts and the 6 October 2026, 12:50 UTC inventory date are retained.

No production request, database migration, data deletion, push, deployment or mobile publication was performed. These are local unreleased changes. Simulator/physical-device execution is not claimed for this transport-only task.
