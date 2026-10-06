#!/usr/bin/env bash
# Administrator bootstrap from a reviewed, pinned Git commit. Does not enable deployment.
set -euo pipefail
[[ $(id -u) == 0 && $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || { printf 'Usage as root: install-automatic.sh FULL_COMMIT_SHA\n' >&2; exit 1; }
command -v python3 >/dev/null
umask 077
source_commit=$1
base="https://raw.githubusercontent.com/GeneralKP/Gramatikapp-API/$source_commit"
staging="/root/gramatik-auto-bootstrap/$source_commit"
install -d -m 0700 "$staging"
for file in poll-release.py validate_release.py deploy-release.sh gramatik-deploy.service gramatik-deploy.timer audit-isolation.py README.md; do
  curl -4fsS --connect-timeout 10 --max-time 30 "$base/deploy/ovh/$file" -o "$staging/$file"
done
python3 "$staging/audit-isolation.py" save "$staging/before.json"
if ! command -v git >/dev/null; then
  # Use the distribution's signed packages; list restart recommendations without restarting services.
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
  apt-get update
  apt-get install -y --no-install-recommends git
fi
bash -n "$staging/deploy-release.sh"
python3 -m py_compile "$staging/poll-release.py" "$staging/validate_release.py"
# Updating administrator-owned deployment components must never race activation.
if systemctl is-active --quiet gramatik-deploy.service; then
  printf 'Wait for the existing Gramatik deployment to finish.\n' >&2
  exit 1
fi
if systemctl is-enabled --quiet gramatik-deploy.timer 2>/dev/null; then
  printf 'Pause the Gramatik timer before updating its privileged components.\n' >&2
  exit 1
fi
install -d -m 0755 /usr/local/lib/gramatik-deploy
install -d -m 0700 /var/lib/gramatik-deploy
if [[ ! -e /root/gramatik-auto-bootstrap/deploy-helper-before-auto.sh ]]; then
  cp /usr/local/sbin/gramatik-deploy-api /root/gramatik-auto-bootstrap/deploy-helper-before-auto.sh
fi
install -m 0755 "$staging/poll-release.py" /usr/local/sbin/gramatik-poll-api
install -m 0644 "$staging/validate_release.py" /usr/local/lib/gramatik-deploy/validate_release.py
install -m 0755 "$staging/deploy-release.sh" /usr/local/sbin/gramatik-deploy-api
install -m 0644 "$staging/gramatik-deploy.service" /etc/systemd/system/gramatik-deploy.service
install -m 0644 "$staging/gramatik-deploy.timer" /etc/systemd/system/gramatik-deploy.timer
install -m 0600 "$staging/README.md" /etc/gramatik-api/OPERATIONS.md
systemd-analyze verify /etc/systemd/system/gramatik-deploy.service /etc/systemd/system/gramatik-deploy.timer
systemctl daemon-reload
python3 "$staging/audit-isolation.py" verify "$staging/before.json"
printf 'Gramatik automatic-deployment components prepared; timer remains disabled.\n'
