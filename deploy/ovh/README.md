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
- CORS: exact Cloudflare and retained Netlify origins in `WEB_ORIGINS`:
  `https://german-gramatic-preview.kevinandrespmgelcas.workers.dev,https://gramatikapp.netlify.app`.

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

The Cloudflare frontend uses `VITE_API_URL=https://vps-0f140ad8.vps.ovh.net:8443`
in its build variables. Cloudflare Git builds track `main` in Gramatikapp-Web,
with `npm run build:cloudflare` and `npx wrangler deploy`. GraphQL, durable study
sync and word lookup use the OVH origin; Writing hints use their existing GraphQL
mutation. Opening Reading/Writing still does not trigger generation. Netlify's
API configuration remains on Render during the migration observation period.

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
Gramatik release, and restores the previous one if local readiness fails. Automatic main releases use the separate pull-based mechanism below; the manual
command remains available. Neither mechanism reuses Hope's deployment tunnel or pipeline.
Record release IDs and retain the previous release. Restore its current symlink
and restart only `gramatik-api` if a new release fails its local health check.

Retain Render during the initial migration observation period. Frontend rollback
is restoring Cloudflare's API build variable to the previous Render origin and
publishing a fresh build, using the same Atlas database and JWT secret. This changes routing only;
it does not restore a database snapshot or erase practice performed since cutover.

## Automatic backend releases from main

The API checks workflow builds/tests on GitHub-hosted runners. Only a successful
push to main can publish a compiled release. Its separate deploy job has a
short-lived repository contents-write token; pull-request jobs have read access
and never publish. It writes only a credential-free archive (dist, package.json,
package-lock.json) and checksum/commit/run manifest to the dedicated
ovh-production-releases branch. This generated branch is replaced with one
snapshot; it is not a source-development branch. Concurrent publishers are
serialized and skip superseded main commits.

The VPS's gramatik-deploy.timer checks about once a minute using outbound HTTPS.
The public repository requires no GitHub token or SSH key on the VPS, no public
SSH listener, webhook, self-hosted runner, or Hope deployment tunnel. Before
calling the existing root-owned deployment helper, the poller independently
checks that the manifest names the current main commit, the same repository's
push workflow, the exact run attempt and its successful verify job. GitHub API
requests occur only for a new candidate, not on every idle tick. Network/API
failures retain the running version; making the repository private will pause
this mechanism until separately scoped authentication is configured.

Archives are bounded and reject path traversal, links, special files, duplicate
entries, secrets and unexpected paths before extraction by gramatik-build in a
separate bounded transient service started by systemd. The root controller keeps
its UID-switch restrictions; it does not invoke a setuid helper.
Dependency installation ignores lifecycle scripts and has its own time/resource
limits. A shared lock prevents manual/automatic deployments racing. Only
gramatik-api is restarted. Its uncached /health response includes the validated
RELEASE commit marker; the helper checks that exact commit locally, and GitHub
checks it over public HTTPS before declaring deployment successful. If the runner’s native Node probe fails, a bounded IPv4 curl probe verifies the same hostname, TLS certificate and exact commit; failures are logged without relaxing certificate validation. Local
readiness failure restores the preceding Gramatik release. A failed candidate
is held rather than restarted every minute; push a corrected commit or explicitly
clear /var/lib/gramatik-deploy/failed-commit to retry. Existing completed releases
can be reused only when their archive checksum matches.

Poller/validator/helper scripts are installed as administrator-owned files.
Application releases do not replace those privileged scripts or service units;
changes to deployment infrastructure require an administrator update. The
deployment service cannot access either application's protected environment or
Hope's configuration/releases. Atlas, JWT, study IDs and the device outbox are
unchanged. npm installation/restart means a short service interruption; this
is not a zero-downtime deployment or a database-migration framework.

Inspect automatic releases:

    systemctl status gramatik-deploy.timer gramatik-deploy.service
    journalctl -u gramatik-deploy.service -n 60
    cat /var/lib/gramatik-deploy/status.json
    curl -fsS https://vps-0f140ad8.vps.ovh.net:8443/health

Pause automatic activation with systemctl disable --now gramatik-deploy.timer.
Let any active deployment finish before manually changing the current symlink.
Resume with systemctl enable --now gramatik-deploy.timer. The manual helper is
still available. Do not delete or reseed database records when reverting code;
future schema migrations need their own backwards-compatible rollout.

Administrator bootstrap installs poll-release.py as
/usr/local/sbin/gramatik-poll-api, validate_release.py under
/usr/local/lib/gramatik-deploy, deploy-release.sh as
/usr/local/sbin/gramatik-deploy-api and the dedicated timer/service units under
/etc/systemd/system. Validate the units, reload systemd, then enable only the
Gramatik timer. No new key or application secret is required.
