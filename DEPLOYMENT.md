# Production deployment

The production backend is the isolated OVH service described in
[deploy/ovh/README.md](deploy/ovh/README.md). The Cloudflare frontend connects to
`https://vps-0f140ad8.vps.ovh.net:8443`; Cloudflare builds and deploys frontend
commits from `main`. Backend commits currently require the separate OVH release
command. Render and Netlify remain available during the migration observation
period.

The API runs as a persistent Node 24 service, using `npm ci`, `npm run build`, and `npm start`, or the included Dockerfile. Persistent service hosting is required because reading/writing jobs continue after the initial HTTP response. Do not deploy this process as a short-lived serverless function.

Configure these server environment variables through the host's secret settings:

- `MONGODB_URI` (or `DB_USER`, `DB_USER_PASSWORD`, `DB_CLUSTER`) for the existing database.
- `JWT_SECRET`, retaining the current secret if existing sessions should remain valid.
- `OPENAI_API_KEY` for Luna access, generation, checks and hints.
- `DEEPL_API_KEY` for the existing phrase translation service.
- `WEB_ORIGINS`, a comma-separated list of allowed frontend origins.
- `NODE_ENV=production` and `PORT` (4000 on OVH).
- `HOST=127.0.0.1` for the private OVH API listener behind its HTTPS proxy.

The service must be allowed to connect to MongoDB from its outbound network. Keep credentials out of Git and frontend environment variables. `/health` confirms a started API; `/graphql` and `/api/translate` are the app endpoints.

For the web repository, Cloudflare uses `npm run build:cloudflare`, `npx wrangler deploy`, and the OVH origin in its build-time `VITE_API_URL`. Static assets use the app-route fallback for direct visits and reloads. GraphQL, study batches and word lookup go directly to OVH; Writing hints use GraphQL. Netlify's retained configuration builds `dist` and uses its existing Render connection.

After deployment, verify health, sign-in, a direct-route reload, the dictionary level filter, new-card German recognition followed by German typing, a saved failure after Back/Undo, a reading lesson, writing generation/check/hint, and a mobile viewport. A successful local build or Git push does not confirm deployment.
