# Project instructions

Be pragmatic and straightforward.

## Required database documentation

`docs/database-model/index.html` is the canonical saved database and data-flow diagram. It must stay independent of the app.

Before editing the model or data flow, read and apply [.agents/skills/german-database-model/SKILL.md](.agents/skills/german-database-model/SKILL.md). Every such edit must include an update to the diagram in the same task/commit before completion or pushing. Cover collections, embedded fields, IDs and relationships, indexes, queries/mutations, imports/migrations, catalog classification, scheduling, mistakes and exercise generation/assessment/reinforcement. For behavior-preserving refactors, record the affected model/flow review without inventing a schema change.

Review related frontend request and persistence changes as well. Keep inventory counts explicitly dated; only replace them after a real read-only audit. Pure styling edits with no data-flow change are exempt.
