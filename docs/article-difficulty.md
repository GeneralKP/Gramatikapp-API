# Noun article difficulty

Prepared locally on 15 October 2026. **Unreleased.** Deployment and mobile publication were subsequently requested; this checkout remains prepared until release.

Holding Again exposes **Revisit article** above Revisit when the card is a noun with a stored article. It applies the existing Revisit transition and records an article mistake. Holding Hard exposes **Article difficulty**; as clarified by the owner, it records an article mistake and applies the ordinary Hard rating. Both advance after the commands are durably saved. Word cards without a noun category/article and phrase cards keep their existing ratings.

`userprogresses.articleFailureIndex` is a separate lifetime counter on the owned directional card, defaulting to zero for existing records. `articleFailureAttemptIds[]` deduplicates each command; `lastArticleFailedAt` retains the greatest original occurrence time. An `ARTICLE_FAILURE` command uses the existing `/api/study/sync` journal with `id`, `itemId`, `itemType: WORD`, `occurredAt` and `sessionId`. It carries no grade or schedule version. The API validates ownership and the German vocabulary record through `relationId ?? itemId`, then increments the counter and adds its retry ID in one atomic write. It adds no collection or index; the existing owner/card index is sufficient.

The article command is independent of review version conflicts and never updates the scheduler, general `failureIndex`, or Writing reinforcement. The accompanying HARD/REVISIT command retains its established behavior, including Revisit’s own general failure. Undo restores scheduling and retains both mistake histories. An acknowledged article retry remains successful after a later catalog edit. Network failures retain the original command on the device.

Compact study selections, manifest shells and hydrated card responses return `articleFailureIndex` and applied `articleFailureAttemptIds`; GraphQL progress exposes the same fields. Clients skip already represented attempt IDs when projecting pending commands, so a committed server write with a delayed acknowledgement cannot double the count. Web and native project and checkpoint article counters independently of schedule snapshots. Their feedback shows the count. The standalone [database diagram](database-model/index.html) records the fields and flow; its inventory snapshot remains unchanged.

## Local verification

- `npm run build`
- `MONGODB_URI=mongodb://127.0.0.1:27043/gramatikapp npm run test:article-failures` against a disposable local replica set, with fixture cleanup. Covers eligibility, ownership, concurrent duplicate/distinct attempts, timestamp order, Hard/Revisit/Undo, lost acknowledgements, stale review conflicts and fresh REST/GraphQL counters.
- `npm run test:study-sync-validation`
- `npm run test:practice-consistency`
- `npm run test:study-scheduling`
- `node scripts/generateBrowserScheduler.mjs --check`

Client UI/storage checks and native runtime limits are recorded in the mobile `docs/verification.md` and the client test scripts. No authenticated production testing or exercise generation was used.
