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
actual_sha=$(sha256sum -- "$archive" | cut -d ' ' -f 1)
[[ "$actual_sha" == "$expected_sha" ]] || { printf 'Archive checksum mismatch.\n' >&2; exit 1; }
base=/opt/gramatik-api
release="$base/releases/$release_id"
[[ ! -e "$release" ]] || { printf 'Release already exists; refusing overwrite.\n' >&2; exit 1; }
install -d -m 0755 "$base/releases"
install -d -m 0755 -o gramatik-build -g gramatik-build "$release"
# The archive contains only the compiled app and locked package metadata.
while IFS= read -r entry; do
  [[ "$entry" != /* && ! "$entry" =~ (^|/)\.\.(/|$) ]] || { printf 'Unsafe archive path.\n' >&2; exit 1; }
  case "$entry" in dist|dist/*|package.json|package-lock.json|deploy|deploy/*) ;; *) printf 'Unexpected archive entry.\n' >&2; exit 1;; esac
done < <(tar -tzf "$archive")
runuser -u gramatik-build -- tar -xzf - --no-same-owner -C "$release" < "$archive"
test -f "$release/dist/index.js"
test -f "$release/package-lock.json"
systemd-run --quiet --wait --collect --unit="gramatik-build-${release_id:0:12}" \
  -p User=gramatik-build -p Group=gramatik-build -p WorkingDirectory="$release" \
  -p 'Environment=HOME=/var/cache/gramatik-build' \
  -p 'Environment=npm_config_cache=/var/cache/gramatik-build/npm' \
  -p MemoryMax=512M -p CPUQuota=50% -p TasksMax=128 -p NoNewPrivileges=yes \
  -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes \
  -p "ReadWritePaths=$release /var/cache/gramatik-build" \
  -p 'InaccessiblePaths=-/etc/hope-and-heart -/opt/hope-and-heart -/etc/gramatik-api -/etc/cloudflared -/etc/caddy' \
  /usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R root:root "$release"
# Builds may inherit an administrator's restrictive umask. Runtime users need
# read/traverse access to this credential-free release, but cannot change it.
chmod -R u=rwX,go=rX "$release"
printf '%s\n' "$release_id" > "$release/RELEASE"
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
ln -s -- "$release" "$base/current.next"
mv -Tf -- "$base/current.next" "$base/current"
activated=true
systemctl restart gramatik-api.service
ready=false
for attempt in $(seq 1 30); do
  if curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:4000/health > /dev/null; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { printf 'Gramatik did not become ready; restoring its previous release.\n' >&2; false; }
trap - ERR
printf 'Gramatik release %s healthy.\n' "$release_id"
