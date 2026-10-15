# Model and GraphQL resolver audit

Prepared 15 October 2026. **Unreleased**, based on API commit `10f25b8`. All six GraphQL resolver modules, their persisted models and collection/index consumers were reviewed. No database migration, stored-field deletion or public schema change is required.

## Changes

- Removed the unused 80-line SM-2 `progress.service.ts`. Its only consumers were two legacy tests. Anki checks now exercise the actual import initializer and production scheduler against literal official Anki fixture answers, including mature intervals beyond one year. This supersedes the earlier decision to retain it in [the first cleanup](model-auth-hardening.md).
- Reduced `seedService.ts` from 278 to 173 lines with three small local helpers. Seed inputs reuse the existing forms, related-word and explanation types. Six sequential import stages, last-write temporary identities, existing document reuse, reference order/duplicates, warning text, result counters and cache invalidation after partial failures remain intact.
- Centralized authenticated ownership in `auth.context.ts`. Authentication and account matching precede ID parsing and database work. Settings retain read → not-found check → validation → update → reread ordering, explicit zero quotas and request-scoped profile fallback.
- Shared catalog ID/date formatting and joined relation hydration. Resolver parents now describe projected and nullable documents. Cached slots retain the distinction between absent, null and undefined; phrase references retain their original order and duplicates. Catalog pipeline stages and filters remain equivalent.
- Separated study selection from GraphQL wiring. Compact HTTP transport imports `studySelection.ts` directly; the old resolver exports remain available to scripts. All six moved selection functions match the baseline AST after the ownership-helper/type substitution, preserving query contents, allocation, quotas, siblings, ordering and concurrency.
- Separated progress formatting and learning-path aggregation. A missing legacy scheduler is derived once per response rather than four times. Stored defaults remain untouched. Learning paths retain word-before-phrase context levels, directional mastery folding, the existing shared relation-ID mastery set, the exact 50% unlock boundary, empty-level behavior, labels and sorting. Malformed legacy context values that the old code skipped still get skipped.
- Separated Reading/Writing response presentation from persistence and async jobs. Reading aggregate results use the fields actually projected. Answer masking, previous successful attempts, retry behavior, job leases, provider requests and reinforcement transactions remain unchanged. Removed unused internal export modifiers and expanded Writing model declarations for readability.

## What remains, and why

No persisted field or index met the evidence threshold for deletion. The 18 live collection handles and four archive collections retain consumers. Examples that can look redundant during a local reference search:

| Model element | Reason to preserve it |
| --- | --- |
| `User.studySyncVersion` | Its write provides a transaction conflict boundary for concurrent new-card quotas. |
| `sourceFailureCount`, `lastWritingReinforcedAt` | Preserve imported mistake baselines and reinforcement audit metadata. Lifetime mistakes and active difficulty remain distinct. |
| Anki deck/original-deck and ordinal metadata | Import, migration and due-date synchronization depend on their source identities. |
| Legacy scheduling fields, imported scheduler order options | Support initialization and persisted/client scheduler compatibility. |
| Generation tokens, locks and `reinforcementAppliedAt` | Prevent stale workers, duplicate results and repeated reinforcement, including zero-credit outcomes. |
| Word/Phrase level enums | Stored values, importer/tooling imports and older request contracts still use them. |
| Translation phrase-reference, review and card-edit indexes | Maintenance tools and different owner/receipt/read query shapes require them. |

No generic asynchronous job framework or automatic schema pruning was introduced. Those changes would need a separate behavior and migration case.

## Regression evidence

Five new characterization suites run through `npm run test:model-refactor`: catalog resolvers, authentication settings, exercise presentation, progress responses and seed imports. They passed before their respective implementations changed and after the refactors. Imported scheduler regressions run through `test:anki`; learning-path cases extend `test:loading`.

The progress fixture compares the entire versioned GraphQL response, including serialized study-state bytes, missing defaults, temporary versus regular due dates and Known state. Twenty-two progress authorization cases and all eleven exercise operations reject before invalid-ID/database work. Existing loading, scheduler and transaction suites cover new/learning/relearning, buried cards, quotas and undo beyond the mature-card serialization fixture.

Deliberately incorrect variants were rejected by behavioral assertions: cached-slot fallback, truthy-zero settings, missing finally invalidation, deduplicated phrase references, a 365-day scheduler cap, premature Reading/Writing answer visibility, greater-than-50% unlocking and ignored temporary due dates. Restored source passes. Selection extraction also received two independent AST comparisons, and each major slice received independent review.

Final local results:

- All **37 backend verification command groups passed**, including the complete existing CI verification, the new suites, official scheduler fixtures, real MongoDB catalog/query/performance checks, study curriculum allocation, Known/both-directions/Undo, review retries and transactions, synchronization, card edits and 15 deployment-controller Python tests. Commands, guarded environment and output are retained in ignored `artifacts/resolver-audit/verify.py` and `verification.log`.
- Both complete existing Reading/Writing integration scripts passed against a separate MongoDB 8.0.34 replica-set fixture and local HTTP provider fixtures. They exercised generation, input/output validation, concurrent idempotent starts, masking/reveal, saved retries, interrupted leases, account isolation and durable reinforcement. A disposable runner remapped the hardcoded application database to a unique fixture database and deleted that fixture afterward; it never loaded production credentials or used paid providers.
- Source build and a separate TypeScript check of all six new test files passed. Independent review found no unresolved actionable issue.
- Both client typechecks passed. The web Apollo-cache, curriculum-order and 12 answer comparisons passed. Mobile passed 87 tests across nine focused request, data, dictionary, scheduler-order and Reading/Writing screen/state suites; one HTTP-listener case was deliberately excluded from that client-only run. Backend HTTP transport tests passed separately.
- All 50 actual web/native GraphQL request variants validate against the current SDL, including dynamic authentication modes. Eighteen current API exercise response variants pass the actual mobile validators. The clean client scheduler files remain byte-identical. No client code change was needed.
- All eight standalone diagram views rendered with valid nodes and edges. The desktop and 390-pixel layouts had no body overflow or console errors; only the local document was requested. Historical counts and their inventory date are unchanged.

Test output and disposable mutation runners remain in ignored `artifacts/resolver-audit/` and `artifacts/model-audit/`. All task-owned fixture containers and preview servers were stopped after verification. These checks establish the tested contracts; they do not claim exhaustive browser/device or production runtime coverage.

## Release boundary

All work remains local and unreleased. No production data, providers, application environment variables, dependency versions or live accounts were changed. Synthetic data belongs to owned loopback MongoDB fixtures; Reading/Writing provider responses come from local HTTP fixtures. Browser/native runtime testing and production rollout are separate from these local checks.

The [canonical database diagram](database-model/index.html) records this review and retains the production inventory date of 6 October 2026, 12:50 UTC and its counts.
