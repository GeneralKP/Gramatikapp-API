# Latency Optimization Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task. Preserve the physical working-tree baseline, including existing uncommitted behavior.

**Goal:** Stop retransmitting unchanged catalogs, then reduce expensive query traffic while preserving every feature in web and native clients.

**Architecture:** Keep the existing MongoDB model. Validate immutable shared catalog snapshots with compact content signatures, then bound or compact account-specific reads without changing scheduling eligibility, content, order or persistence contracts.

**Tech Stack:** TypeScript, MongoDB 8, GraphQL, React web, Expo native.

**Spec:** [Measured latency investigation](../../atlas-latency-investigation.md) plus the owner's active goal: prepare and verify catalog changes locally first; subsequent API/web/native deployments are authorized for this goal. Paid infrastructure changes require separate authorization.

## Global Constraints

- Preserve features and current physical workspace behavior, including permanent five-year completion and temporary Revisit retaining the regular schedule.
- Keep the database structure for the catalog stage. No new persisted catalog signatures, user copies or collections.
- Verify equivalent web and native behavior. HTTP contracts, owner isolation, offline recovery, version guards, mistakes, Undo and synchronization remain equivalent.
- No synthetic users or progress against production. Use only an isolated loopback MongoDB fixture for synthetic data; only the existing designated test account for authenticated live testing.
- Credentials remain in the owner's protected key file; never log or copy them into source, reports or receipts.
- Update `docs/database-model/index.html` with each data-flow stage; retain the dated production inventory counts.
- Preserve pre-existing edits. Review task-only diffs against `.local/latency-task-baseline`, not just tracked HEAD.
- No publication during the initial catalog preparation/verification stage. Later deployments use the owner's explicit goal-specific permission.

## Review Focus

- External catalog corrections without `updatedAt`, deletion and filter membership changes must become visible within the existing freshness bound.
- Invalidation or failure during a concurrent check/load must not publish an obsolete generation or extend stale data's deadline.
- Reviewed labels can invalidate Writing candidates; selecting raw rows before usability validation must not underfill or change results.
- Imported/custom scheduler options, null versus missing relation IDs, orphan catalog references and completion boundaries must retain their current meanings.
- Large account counts and cold/offline client entry must remain correct after transport reductions.

### Task 1: Catalog freshness without repeated bulk transfer

**Files:** `catalogSummaryCache.ts`, new `catalogPartSource.ts` in `src/features/progress`, `studyLoading.ts`, `studyTextCatalog.ts`, `src/features/phrases/phraseGrammarCatalog.ts`, `scripts/testCatalogCache.ts`, new `scripts/testCatalogSignatures.ts`; root coordinates package/CI and canonical diagram.

**Interfaces:**

```ts
export interface CatalogSnapshot<T> { rows: T[]; signature: string }
export interface CatalogSource<T> {
  loadSnapshot(): Promise<CatalogSnapshot<T>>;
  readSignature(): Promise<string>;
}
export function readCatalogPart<T>(db: Database, part: CatalogPart, refresh?: boolean): Promise<T[]>;
```

- [ ] Add failing cache tests: unchanged refresh/hard expiry retains exact array identity and performs no bulk load; changed signatures reload only the changed part; concurrent reads/checks remain singleflight; invalidation wins during check and load; failures never extend the old deadline and expired reads retry/error.
- [ ] Add guarded real MongoDB 8 tests for all seven descriptors, projections, edits/inserts/deletes, ignored unprojected edits, grammar filter membership, empty collections, ObjectIds, missing/null, arrays, forms, fractional numeric and numeric/string changes. Guard URI host as loopback and database as a dedicated fixture name before connecting or dropping anything.
- [ ] Centralize the current filters/projections exactly once. Each row's two salted 64-bit hashes use the same normalized projected values in snapshot and probe. Normalize numeric leaves to type/string so hashing does not truncate fractions; preserve absent fields versus null and ObjectId types.
- [ ] Bind each loaded baseline to hashes returned alongside its actual rows. Sum exactly using BigInt locally and Decimal128 in the server group; serialize count and checksum strings. Strip hash wrappers before cache/API use.
- [ ] On unchanged validation keep the frozen array/index identity and extend freshness after success. On change reload only that part. Fresh reads remain immediate during checks; hard-expired reads await the shared check/reload. Preserve generation guards and every existing writer invalidation.
- [ ] Retain the existing 15-second timer and 30-second hard expiry; the timer checks signatures rather than fetching all content. No new schema, indexes, user-state cache or multi-part transaction guarantee.
- [ ] Run the existing cache baseline plus integration, scheduler/loading and build checks. Compare projections with the baseline. Measure BSON requests/replies and ensure an unchanged validation returns at most 1 KB per part, with zero full catalog reads.
- [ ] Update and render the canonical diagram; run both clients' loading/cache/offline contract checks. Review the task-only diff before marking this stage prepared.

### Task 2: Bound Writing selection and Reading session discovery

**Files:** `src/features/writing/vocabulary.ts`, `src/features/reading/reading.service.ts`, guarded fixture regression scripts, diagram.

- [ ] At fixed time/seed compare complete old and new outputs over reviewed labels, CEFR levels, failures/reinforcement, suspension, fewer-than-limit cases and manual ordering.
- [ ] Sort grouped practiced progress before rich joins: all ordering keys already exist on the group, so post-join CEFR/usability filtering retains the same relative order while avoiding a rich-row sort. Stream with a small cursor batch and stop after the required usable words. Difficult lists filter positive difficulty; automatic DIFFICULT retains practiced zero-difficulty candidates. RECENT ranks minimal effective labels/IDs and first-read scores for its first 180 usable pool, then hydrates rich content only for the selected winners; verify cursor command counts as well as bytes. DIFFICULT/manual rich streaming sizes batches near the requested usable count instead of hard-coded tiny batches. Manual selected IDs retain supplied order. Never limit raw rows before reviewed-label usability validation.
- [ ] For fallback, project minimal effective labels/IDs using the existing shared reviewedWordContentExpression validity predicate (version, nonempty string German/Spanish, string notes), rank every usable candidate by the existing SHA seed+ID algorithm, then hydrate rich forms/notes only for selected winners. Preserve base CEFR eligibility, chosen-ID exclusion, fallback zero difficulty values, full reviewed forms/notes validation and final ranking order. Revalidate hydrated winners; if an intervening edit makes one unavailable, scan remaining ranked candidates to fill the same requested count. No database schema/migration or per-user cache.
- [ ] Project Reading's session-discovery events to `_id`, `reviewedAt`, `itemId`, `itemType`; retain all cursor batches and the existing algorithm. Test 30-minute boundaries, phrase-only and repeated-direction histories, equal timestamps and old qualifying sessions.
- [ ] Bound lesson attempt replies to the latest attempt per page plus whether any READY attempt exists, preserving `{createdAt:-1,_id:-1}` tie ordering. A newer FAILED/CHECKING attempt must not hide an older READY reference. Differentially compare complete lessonForClient outputs, including empty pages and account/lesson isolation.
- [ ] Measure difficult-six <20 KB and discovery first batch <15 KB in the large fixture; target at least 80% lower RECENT/fallback payloads. Verify Reading/Writing contracts in both clients and update the diagram.

### Task 3: Compact dashboard summaries

**Files:** new `src/features/progress/studyAccountSummary.ts`, `studyLoading.ts`, `studySummaries.ts`, dashboard consumers in `progress.resolvers.ts`, fixture tests, diagram.

- [ ] Differentially test every counter/curriculum against the baseline, including missing/null relation IDs, orphan references, reviewed embedded cards, categories, typed IDs and legacy schedules.
- [ ] Aggregate fresh owner state into compact typed-identity/category-fallback buckets, then apply the existing request's cached catalog generation in JS. Remove large catalog-ID request predicates without silently switching to a newer DB catalog. Group nonzero per-identity counts again by common item type, rich-card presence, missing/null relation category behavior and numeric review/learning counts; carry an ObjectId array per identical bucket so repeated metadata/counts do not bloat a 4,000-card reply. Keep exact BSON ID matching and the database predicate's card-not-null semantics. Zero-count buckets can be omitted.
- [ ] Pack known/allocation identity arrays while restoring the internal representation. Preserve request-only reuse, new allocation timing, typed exclusions and the learning path's existing type-agnostic learned-ID union.
- [ ] Keep NEW/legacy/zero-interval states on compatibility reads with complete scheduling inputs for completion. Target known summary request <3 KB and packed reply <=80 KB on the large fixture.
- [ ] Verify dashboard/loading/practice on web/native and update the diagram.

### Task 4: Deduplicate practice scheduler options

**Files:** `studyCandidates.ts`, packed-read helper, `studyTransport.ts` as needed, scheduler/queue differential fixtures, diagram.

- [ ] Prove exact queue/state equality for tied dates, custom/imported options, deck ancestors, quotas, burial, suspension, sibling directions, completion, extra practice, temporary due and future manifests.
- [ ] Return all selected states in their original order without repeated options, alongside unique full option objects and membership references. Reattach before scheduler/queue logic. Do not substitute the current profile or introduce an early candidate limit.
- [ ] Guard MongoDB aggregate result/memory limits with a compatible read fallback. Target mixed reply <=650 KB and at least 90% fewer repeated option bytes with no additional normal-path round trips.
- [ ] Verify rating/Undo/offline/starter/full hydration on both clients, then update the diagram.

### Task 5: Index import anti-joins

**Files:** `src/lib/database.ts`, import diagnostic queries in `words.resolvers.ts`, guarded explain fixtures, diagram.

- [ ] Compare exact results for both languages, duplicate/missing relations, phrase word arrays and limits before and after.
- [ ] Prepare foreign indexes on word relation `main`/`translated` and phrase `words`; use projected existence lookups limited to one match without moving the result limit ahead of the anti-join.
- [ ] Confirm foreign index use and <30,000 examined documents against the baseline's 2,996,640 on a representative fixture. Record server work separately from network bytes.

### Task 6: Full validation, delivery and live measurement

- [ ] Review the complete task-only API diff and any client changes. Pass required API, web and native checks plus current-source runtime walkthroughs on both native platforms.
- [ ] Confirm canonical diagram content/rendering and preserve inventory dates.
- [ ] Once the catalog preparation stage is verified, use the owner's goal-specific authorization for required API/web/native deployments. Package only reviewed features; preserve pre-existing work and rollback capability.
- [ ] Re-measure the same VPS query seams and designated test account's actual screens; distinguish rolling M0 quota delay from optimizations and physical-device limits. Do not upgrade paid Atlas tiers without separate authorization.
- [ ] Report before/after timings and transfer sizes, tested feature parity, remaining measured limits and deployment revisions. Mark the active goal complete only after its entire scope is achieved.
