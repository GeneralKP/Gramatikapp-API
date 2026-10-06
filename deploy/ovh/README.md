# Gramatik on OVH

Gramatik has dedicated `gramatik-api` and `gramatik-proxy` system accounts,
systemd services, release/configuration directories, and certificate storage.
Both accounts have locked passwords and no login shell. No Hope & Heart service,
directory, secret, tunnel, or deployment command is reused or restarted.
The shared host and its operating system remain a shared failure domain.

## Runtime

- Node 24; compiled `dist/` and the locked production npm dependencies.
- API: `127.0.0.1:4000`, `HOST=127.0.0.1`, `NODE_ENV=production`.
- Environment: `/etc/gramatik-api/api.env`, root-owned mode 0600, loaded by systemd.
- Releases: `/opt/gramatik-api/releases/<commit>`; root-owned and read-only to the API.
- Active release: `/opt/gramatik-api/current`.
- HTTPS proxy: `/etc/gramatik-proxy/Caddyfile`, separate Caddy process on TCP 8443.
- Certificates: `/var/lib/gramatik-proxy`, isolated from Hope's Caddy files.
- Proxy admin API: `/run/gramatik-proxy/admin.sock`, inside its private runtime directory.
- HTTP 80: ACME certificate validation only; no plaintext app endpoint.
- MongoDB: existing production Atlas `gramatikapp` database; no import/reseed.
- CORS: `WEB_ORIGINS=https://gramatikapp.netlify.app`.

Keep the existing production JWT secret to preserve sign-ins and durable study
commands. Configure the existing DB and AI keys only in the protected environment
file. Do not include an account password, VPS sudo password, or Hope secrets.

The VPS firewall needs only Gramatik TCP 80 (ACME) and 8443 (HTTPS) in addition to
the existing rules. It must keep Node port 4000, the proxy admin port, and SSH
closed externally. Do not disable UFW or modify Hope's routes.

## Deployment and verification

Build and test a clean release locally; transfer the compiled archive and its
SHA-256 manifest. Install dependencies with `npm ci --omit=dev` as a separate
build account, then make the release root-owned before activation. Validate
both units and Caddy's configuration before starting the Gramatik services.

Check `/health`, GraphQL with an existing production token, scoped word/phrase
queries, CORS preflight, and unauthenticated rejection of protected REST routes.
Verify that a service restart preserves the account's schedules and counters.
Confirm Hope's service PIDs/start times and configuration checksums remain intact.

Only after those checks, set Netlify's production `VITE_API_URL` and `API_URL` to
the new HTTPS origin and rebuild the frontend. Both GraphQL and durable study
sync must use that origin. `API_URL` is also used by the Netlify translation
function. Opening Reading/Writing still does not trigger generation.

The API gracefully drains HTTP requests before closing MongoDB on SIGTERM.
Unacknowledged browser commands remain durable and retry normally; the backend
migration does not alter review IDs, schedules, or mistake accounting.

## Operations and rollback

Use `systemctl status gramatik-api gramatik-proxy` and
`journalctl -u gramatik-api -u gramatik-proxy`. Restart only the Gramatik API for
new application releases; reload only the Gramatik proxy for its route changes.
The independent root-only command is `/usr/local/sbin/gramatik-deploy-api
ARCHIVE COMMIT SHA256`; its source is `deploy-release.sh`. It verifies the archive,
installs locked production dependencies in a bounded build service, switches the
Gramatik release, and restores the previous one if local readiness fails. Future
API source pushes still need a Gramatik release deployment; this installation
does not reuse Hope's automatic deployment tunnel or pipeline.
Record release IDs and retain the previous release. Restore its current symlink
and restart only `gramatik-api` if a new release fails its local health check.

Retain Render during the initial migration observation period. Frontend rollback
is restoring Netlify's previous API variables and publishing a fresh build against
Render, using the same Atlas database and JWT secret. This changes routing only;
it does not restore a database snapshot or erase practice performed since cutover.
