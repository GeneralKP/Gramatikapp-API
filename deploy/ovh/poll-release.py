#!/usr/bin/env python3
"""Pull only the current, independently verified main release; no VPS GitHub token."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

REPOSITORY = "GeneralKP/Gramatikapp-API"
REMOTE = "https://github.com/" + REPOSITORY + ".git"
BRANCH = "ovh-production-releases"
MAX_ARCHIVE = 32 * 1024 * 1024


def request_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "gramatik-deploy", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise ValueError("Oversized verification response")
    return json.loads(body)


def validate_manifest(manifest, main_sha, archive):
    if manifest.get("version") != 1 or manifest.get("repository") != REPOSITORY:
        raise ValueError("Unexpected release schema or repository")
    sha = manifest.get("sourceCommit", "")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha) or sha != main_sha:
        raise ValueError("Release is not the current main commit")
    if any(type(manifest.get(k)) is not int or manifest[k] < 1 for k in ("runId", "runAttempt")):
        raise ValueError("Invalid CI identity")
    if len(archive) > MAX_ARCHIVE or hashlib.sha256(archive).hexdigest() != manifest.get("archiveSha256"):
        raise ValueError("Release checksum mismatch or oversized archive")


def verify_ci(manifest, fetch=request_json):
    base = "https://api.github.com/repos/" + REPOSITORY + "/actions/runs/" + str(manifest["runId"])
    run = fetch(base)
    if (run.get("head_sha") != manifest["sourceCommit"] or run.get("event") != "push"
            or run.get("head_branch") != "main" or run.get("path") != ".github/workflows/ci.yml"
            or run.get("run_attempt") != manifest["runAttempt"]
            or run.get("repository", {}).get("full_name") != REPOSITORY):
        raise ValueError("Release does not belong to the expected main CI run")
    jobs = fetch(base + "/attempts/" + str(manifest["runAttempt"]) + "/jobs?per_page=100")["jobs"]
    checks = [job for job in jobs if job.get("name") == "verify"]
    if len(checks) != 1 or checks[0].get("conclusion") != "success" or checks[0].get("head_sha") != manifest["sourceCommit"]:
        raise ValueError("The required verify job has not passed")


class Poller:
    def __init__(self, state=Path("/var/lib/gramatik-deploy"), remote=REMOTE,
                 deployer="/usr/local/sbin/gramatik-deploy-api", verify=verify_ci,
                 health="http://127.0.0.1:4000/health"):
        self.state, self.remote, self.deployer, self.verify, self.health = Path(state), remote, deployer, verify, health
        self.repo = self.state / "repository.git"

    def git(self, *args):
        env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null")
        return subprocess.run(["git", "-c", "credential.helper=", "-c", "gc.auto=0", "--git-dir=" + str(self.repo), *args],
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=60).stdout

    def save_status(self, stage, **extra):
        value = dict(stage=stage, checkedAt=time.time(), **extra)
        path = self.state / "status.next"
        path.write_text(json.dumps(value, indent=2) + "\n")
        path.chmod(0o600)
        path.replace(self.state / "status.json")
        print(json.dumps(value), flush=True)

    def tick(self):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.repo.exists():
            self.git("init", "--bare", "--quiet", str(self.repo))
        self.git("fetch", "--quiet", "--no-tags", "--depth=1", "--atomic", self.remote,
                 "+refs/heads/main:refs/heads/source", "+refs/heads/" + BRANCH + ":refs/heads/release")
        main_sha = self.git("rev-parse", "source").decode().strip()
        tree = self.git("ls-tree", "release").decode().splitlines()
        if len(tree) != 2 or set(line.split("\t")[1] for line in tree) != {"manifest.json", "release.tar.gz"} or any(not line.startswith("100644 blob ") for line in tree):
            raise ValueError("Unexpected release tree")
        manifest_bytes = self.git("show", "release:manifest.json")
        if len(manifest_bytes) > 4096:
            raise ValueError("Oversized release manifest")
        manifest = json.loads(manifest_bytes)
        target = manifest.get("sourceCommit")
        if target != main_sha:
            self.save_status("waiting-for-current-main", main=main_sha)
            return
        if int(self.git("cat-file", "-s", "release:release.tar.gz")) > MAX_ARCHIVE:
            raise ValueError("Oversized release archive")
        archive = self.git("show", "release:release.tar.gz")
        validate_manifest(manifest, main_sha, archive)
        failed = self.state / "failed-commit"
        if failed.exists() and failed.read_text().strip() == target:
            self.save_status("failed-release-held", commit=target)
            return
        # A previously applied commit can be trusted without spending API quota.
        applied = self.state / "applied-commit"
        if applied.exists() and applied.read_text().strip() == target:
            self.save_status("up-to-date", commit=target)
            return
        self.verify(manifest)
        if self.git("ls-remote", "--heads", self.remote, "refs/heads/main").decode().split()[0] != target:
            self.save_status("superseded", commit=target)
            return
        path = self.state / "release.tar.gz"
        path.write_bytes(archive)
        path.chmod(0o600)
        self.save_status("deploying", commit=target, runId=manifest["runId"])
        try:
            subprocess.run([self.deployer, str(path), target, manifest["archiveSha256"]], check=True, timeout=240)
            if request_json(self.health).get("release") != target:
                raise ValueError("Running release does not match the requested commit")
        except Exception:
            failed.write_text(target + "\n")
            self.save_status("failed-release-held", commit=target)
            raise
        applied.write_text(target + "\n")
        failed.unlink(missing_ok=True)
        self.save_status("healthy", commit=target, runId=manifest["runId"])


if __name__ == "__main__":
    if os.geteuid() != 0:
        sys.exit("Run through the Gramatik deployment service as administrator")
    poller = Poller()
    try:
        poller.tick()
    except Exception as error:
        # Git/network/API failures leave the current application untouched.
        print("Gramatik deployment held: " + str(error)[:500], file=sys.stderr)
        sys.exit(1)
