#!/usr/bin/env python3
"""Read-only fingerprints: no secret contents are emitted or copied."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def snapshot():
    services = {}
    for name in ("hope-api", "hope-waitlist-worker", "caddy", "cloudflared-hope-deploy", "gramatik-proxy"):
        data = subprocess.check_output(["systemctl", "show", name, "--property=MainPID,ActiveEnterTimestamp,ActiveState,FragmentPath", "--no-pager"], text=True)
        values = dict(line.split("=", 1) for line in data.strip().splitlines())
        values["unitSha256"] = hashlib.sha256(Path(values["FragmentPath"]).read_bytes()).hexdigest()
        services[name] = values
    stat = Path("/etc/hope-and-heart/api.env").stat()
    return dict(services=services, hopeRelease=os.readlink("/opt/hope-and-heart/current"),
                caddySha256=hashlib.sha256(Path("/etc/caddy/Caddyfile").read_bytes()).hexdigest(),
                hopeEnvironment=dict(mode=stat.st_mode, uid=stat.st_uid, gid=stat.st_gid, size=stat.st_size, mtime=stat.st_mtime_ns),
                firewall=subprocess.check_output(["ufw", "status", "verbose"], text=True))


if __name__ == "__main__":
    mode, path = sys.argv[1:]
    actual = snapshot()
    if mode == "save":
        Path(path).write_text(json.dumps(actual, indent=2) + "\n")
        Path(path).chmod(0o600)
        print("Hope and Heart, proxy and firewall baseline saved without secret values.")
    elif mode == "verify":
        if actual != json.loads(Path(path).read_text()):
            sys.exit("Isolation audit changed; inspect the private baseline before proceeding")
        print("Hope and Heart, Gramatik proxy and firewall unchanged.")
    else:
        sys.exit("Use save or verify with a private baseline path")
