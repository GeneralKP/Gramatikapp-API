# German Gramatic API

GraphQL backend for the German Gramatic language learning application.

## Database model and data flow

The canonical [database diagram](docs/database-model/index.html) is saved in Git as a standalone HTML/CSS page. Open the file directly or serve `docs/database-model` locally. It describes the live catalog, study progress, Reading/Writing flows and archived Anki collections; record counts are an explicitly dated inventory snapshot.

Every model or data-flow edit must update the diagram in the same task before completion or pushing. Apply the [german-database-model skill](.agents/skills/german-database-model/SKILL.md); [AGENTS.md](AGENTS.md) records the project requirement, including companion frontend changes.

## Prerequisites

- Node.js 18+
- MongoDB (local or Atlas)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure environment:
   - Copy `.env.example` to `.env`
   - Set `MONGODB_URI` to your MongoDB connection string
   - Set `DEEPL_API_KEY` to your DeepL API key

3. Seed the database:

   ```bash
   npm run seed
   ```

   Use `npm run seed -- --force` to overwrite existing data.

4. Start the server:
   ```bash
   npm run dev
   ```

The GraphQL Playground will be available at http://localhost:4000

## API Overview

### Queries

- `phrases(filter, limit, offset)` - Get phrases
- `duePhrases(userId, limit)` - Get phrases due for review
- `user(id)` / `userByEmail(email)` - Get user

### Mutations

- `reviewPhrase(userId, phraseId, rating)` - Submit SRS review (rating: 0-5)
- `translate(text, targetLang)` - Translate text via DeepL
- `syncSettings(userId, settings)` - Update user settings
- `createUser(email)` - Create new user

## Loading regression checks

Run `npm run test:loading` for deterministic dashboard/word/phrase/mixed response contracts, bounded query counts and idempotent batched new-card allocation. Run `npm run test:auth` for JWT, login, ownership and authentication-query regressions. Run `npm run audit:loading` for guarded read-only database timings. See [the loading audit](docs/loading-audit.md) for measurements, response-fixture provenance and limitations.
