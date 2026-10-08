# Project instructions

Be pragmatic and straightforward.

## Client parity and deployment

Changes to study/API behavior must preserve and verify equivalent web and native client behavior in the same task. An explicit verbal/chat instruction from the owner is required for each production deployment or mobile GitHub release; prior standing automatic-release permission is revoked. Local implementation and verification are authorized. Do not push to a deployment-triggering branch or publish a deployment artifact without that instruction.

## Vocabulary card content

Follow [docs/word-card-standard.md](docs/word-card-standard.md) for vocabulary corrections and new study cards. Keep dictionary lookup spellings distinct from relation-specific study constructions, preserve source/scheduling identities, and store plain text with real newlines and unnumbered example arrays. Uncertain meanings require review; a format validator does not establish linguistic correctness.

## Required database documentation

`docs/database-model/index.html` is the canonical saved database and data-flow diagram. It must stay independent of the app.

Before editing the model or data flow, read and apply [.agents/skills/german-database-model/SKILL.md](.agents/skills/german-database-model/SKILL.md). Every such edit must include an update to the diagram in the same task/commit before completion or pushing. Cover collections, embedded fields, IDs and relationships, indexes, queries/mutations, imports/migrations, catalog classification, scheduling, mistakes and exercise generation/assessment/reinforcement. For behavior-preserving refactors, record the affected model/flow review without inventing a schema change.

Review related frontend request and persistence changes as well. Keep inventory counts explicitly dated; only replace them after a real read-only audit. Pure styling edits with no data-flow change are exempt.

## Single live test account

Use only the existing `kevin.tester@gmail.com` account for authenticated live tests. Read `test_user_email` and `test_user_password` from `/Users/kevin/Desktop/key.env`; never copy secret values into source, documentation, memory or output. Do not register extra live test users or run synthetic database tests against production. Keep fixture identities in an isolated test database, and leave the owner's two retained personal accounts untouched.
