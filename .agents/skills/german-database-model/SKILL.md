---
name: german-database-model
description: Keep German Gramatic's saved database diagram synchronized whenever its MongoDB model or application data flow is edited, including frontend requests and persistence, imports, scheduling, mistakes, and Reading/Writing flows.
---

# Maintain the German Gramatic database model

The user requires a diagram update for every edit touching the model or data flow. Treat that update as part of the implementation, before completion or pushing.

## Locate the canonical artifact

The API repository owns `docs/database-model/index.html` and this skill. Resolve the API checkout from the current task or its sibling `german-gramatic-api`; when using a worktree, prefer the matching task checkout over the original checkout. The frontend is `german-gramatic-web`. If the API is not adjacent, locate its checkout using project context; its repository is `https://github.com/GeneralKP/Gramatikapp-API`.

Edit the existing HTML rather than creating another model. It is a standalone HTML/CSS/vanilla-JavaScript page, with no application dependency, database connection or AI request. Existing local preview: `http://localhost:5176`; otherwise serve its directory on an available local port.

## Trace the affected behavior

Read the current diagram before the implementation, then trace the relevant source:

- `src/lib/database.ts` for collection names and indexes; feature types for stored and embedded fields; `scripts/importAnki.ts` for the archived import.
- Feature services, resolvers, GraphQL schemas and import/migration/classification scripts for relationships, query scope, persistence and transitions.
- Frontend API modules and their callers for request parameters, manual generation, saved drafts, retries, resume and feedback timing.

Distinguish database collection names from TypeScript property names, stored fields from derived values, embedded documents from collections, and logical references from enforced foreign keys. Show per-user ownership, directional cards and relation identities where relevant. Do not document a proposed field as deployed behavior until implemented.

## Update alongside the change

Update the affected entity fields, relationship arrows/cardinalities, collection inventory and explanatory flow text in the same task. A flow-only edit still requires updating the HTML's explanation of that flow. For behavior-preserving refactors, add a concise dated review note describing the affected flow and the invariant verified; do not invent a schema change or merely change a timestamp.

Cover input/selection, API operation, stored state, derived output and consequential writes. For asynchronous operations, explain any changed status transitions, retry/idempotency rules or failure paths. Keep lifetime mistakes distinct from active difficulty and reinforcement; preserve the distinction between archival Anki records and live study progress.

Collection record counts are an explicitly dated production snapshot. Do not update them or their audit timestamp from guesses, local fixtures or ordinary schema edits. Refresh only with an authorized read-only inventory, labeled with its environment and time. Keep credentials, emails and personal record contents out of the diagram.

## Verify and finish

Review the final source diff against the diagram. Open each affected diagram view and check node text, arrows and relationships; check the readable mobile layout if the HTML layout changed. Confirm the page still runs without app/API calls. Use relevant implementation checks for the changed behavior; do not mutate production to validate documentation.

Include the HTML update in the same API commit as model changes. For frontend-only data-flow changes, include a companion API documentation commit in the same task and report it. Report the saved diagram path and what model/flow was updated. Pure presentation edits that do not touch the model or data flow need no diagram update. This skill does not itself authorize pushes, database writes or deployment.
