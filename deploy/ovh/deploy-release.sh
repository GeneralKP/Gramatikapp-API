#!/usr/bin/env bash
set -euo pipefail
if [[ $(id -u) != 0 ]]; then printf 'Run as the VPS administrator.\n' >&2; exit 1; fi
if [[ $# != 3 || ! $2 =~ ^[0-9a-f]{40}$ || ! $3 =~ ^[0-9a-f]{64}$ ]]; then
  printf 'Usage: gramatik-deploy-api ARCHIVE COMMIT SHA256\n' >&2
  exit 1
fi
archive=$(realpath -- "$1")
release_id=$2
expected_sha=$3
exec 9>/run/lock/gramatik-api-deploy.lock
flock -n 9 || { printf 'Another Gramatik deployment is in progress.\n' >&2; exit 75; }
actual_sha=$(sha256sum -- "$archive" | cut -d ' ' -f 1)
[[ "$actual_sha" == "$expected_sha" ]] || { printf 'Archive checksum mismatch.\n' >&2; exit 1; }
/usr/bin/python3 /usr/local/lib/gramatik-deploy/validate_release.py "$archive"
base=/opt/gramatik-api
release="$base/releases/$release_id"
if [[ -e "$release" ]]; then
  # A retry may reuse only a complete, root-owned release with the same archive.
  [[ ! -L "$release" && $(stat -c %u "$release") == 0 && $(cat "$release/ARCHIVE_SHA256") == "$expected_sha" && $(cat "$release/RELEASE") == "$release_id" ]] || { printf 'Existing release cannot be safely reused.\n' >&2; exit 1; }
else
  install -d -m 0755 "$base/releases"
  staging="$base/releases/.build-$release_id-$$"
  install -d -m 0755 -o gramatik-build -g gramatik-build "$staging"
  trap 'rm -rf -- "$staging"' EXIT
  # PID 1 starts the separate unprivileged extraction service. The controller
  # keeps its own UID-switch restrictions; no setuid helper runs inside it.
  systemd-run --quiet --wait --pipe --collect --unit="gramatik-extract-${release_id:0:12}" \
    -p User=gramatik-build -p Group=gramatik-build -p NoNewPrivileges=yes \
    -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes \
    -p "ReadWritePaths=$staging" \
    -p 'InaccessiblePaths=-/etc/hope-and-heart -/opt/hope-and-heart -/etc/gramatik-api -/etc/cloudflared -/etc/caddy' \
    -p MemoryMax=128M -p CPUQuota=50% -p TasksMax=32 -p RuntimeMaxSec=30 \
    /usr/bin/tar -xzf - --no-same-owner -C "$staging" < "$archive"
  systemd-run --quiet --wait --collect --unit="gramatik-build-${release_id:0:12}" \
  -p User=gramatik-build -p Group=gramatik-build -p WorkingDirectory="$staging" \
  -p 'Environment=HOME=/var/cache/gramatik-build' \
  -p 'Environment=npm_config_cache=/var/cache/gramatik-build/npm' \
  -p MemoryMax=512M -p CPUQuota=50% -p TasksMax=128 -p NoNewPrivileges=yes \
  -p RuntimeMaxSec=120 \
  -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes \
  -p "ReadWritePaths=$staging /var/cache/gramatik-build" \
  -p 'InaccessiblePaths=-/etc/hope-and-heart -/opt/hope-and-heart -/etc/gramatik-api -/etc/cloudflared -/etc/caddy' \
  /usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  chown -R root:root "$staging"
# Builds may inherit an administrator's restrictive umask. Runtime users need
# read/traverse access to this credential-free release, but cannot change it.
  chmod -R u=rwX,go=rX "$staging"
  printf '%s\n' "$release_id" > "$staging/RELEASE"
  printf '%s\n' "$expected_sha" > "$staging/ARCHIVE_SHA256"
  chmod 0644 "$staging/RELEASE" "$staging/ARCHIVE_SHA256"
  mv -T -- "$staging" "$release"
  trap - EXIT
fi
if [[ $(readlink "$base/current" || true) == "$release" ]] && curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:4000/health | /usr/bin/python3 -c 'import json,sys; assert json.load(sys.stdin)["release"] == sys.argv[1]' "$release_id"; then
  printf 'Gramatik release %s already healthy.\n' "$release_id"
  exit 0
fi
previous=$(readlink "$base/current" || true)
activated=false
rollback() {
  if [[ "$activated" == true ]]; then
    if [[ -n "$previous" ]]; then
      ln -s -- "$previous" "$base/current.rollback"
      mv -Tf -- "$base/current.rollback" "$base/current"
      systemctl restart gramatik-api.service || true
    else
      systemctl stop gramatik-api.service || true
    fi
  fi
}
trap rollback ERR
trap 'rollback; exit 1' HUP INT TERM
ln -s -- "$release" "$base/current.next"
mv -Tf -- "$base/current.next" "$base/current"
activated=true
systemctl restart gramatik-api.service
ready=false
for attempt in $(seq 1 30); do
  if curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:4000/health | /usr/bin/python3 -c 'import json,sys; assert json.load(sys.stdin)["release"] == sys.argv[1]' "$release_id" 2>/dev/null; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { printf 'Gramatik did not become ready; restoring its previous release.\n' >&2; false; }
trap - ERR HUP INT TERM
printf 'Gramatik release %s healthy.\n' "$release_id"
