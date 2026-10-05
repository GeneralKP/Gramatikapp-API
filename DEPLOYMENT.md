# Production deployment

The API runs as a persistent Node 24 service, using `npm ci`, `npm run build`, and `npm start`, or the included Dockerfile. Persistent service hosting is required because reading/writing jobs continue after the initial HTTP response. Do not deploy this process as a short-lived serverless function.

Configure these server environment variables through the host's secret settings:

- `MONGODB_URI` (or `DB_USER`, `DB_USER_PASSWORD`, `DB_CLUSTER`) for the existing database.
- `JWT_SECRET`, retaining the current secret if existing sessions should remain valid.
- `OPENAI_API_KEY` for Luna access, generation, checks and hints.
- `DEEPL_API_KEY` for the existing phrase translation service.
- `WEB_ORIGINS`, a comma-separated list of allowed frontend origins.
- `NODE_ENV=production` and the host-provided `PORT` (default 4000).

The service must be allowed to connect to MongoDB from its outbound network. Keep credentials out of Git and frontend environment variables. `/health` confirms a started API; `/graphql` and `/api/translate` are the app endpoints.

For the web repository, Netlify configuration is included: build `npm run build`, publish `dist`, and set `VITE_API_URL` to the deployed HTTPS API origin. The rewrite to `index.html` allows direct visits and reloads of `/reading/:lessonId`, `/writing/:exerciseId`, and other app routes. The optional Netlify translation function forwards authenticated requests to the API and needs no provider key.

After deployment, verify health, sign-in, a direct-route reload, the dictionary level filter, new-card German recognition followed by German typing, a saved failure after Back/Undo, a reading lesson, writing generation/check/hint, and a mobile viewport. A successful local build or Git push does not confirm deployment.
