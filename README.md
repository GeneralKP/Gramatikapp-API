# German Gramatic API

GraphQL backend for the German Gramatic language learning application.

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
