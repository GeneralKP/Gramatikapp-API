import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


poll = load("poll_release", ROOT / "poll-release.py")
validation = load("validate_release", ROOT / "validate_release.py")


def archive_bytes(extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name in ("dist/index.js", "package.json", "package-lock.json"):
            item = tarfile.TarInfo(name)
            data = b"{}"
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
        if extra:
            archive.addfile(extra, io.BytesIO(b""))
    return output.getvalue()


def manifest(sha, archive):
    return dict(version=1, repository=poll.REPOSITORY, sourceCommit=sha, runId=100, runAttempt=1,
                archiveSha256=hashlib.sha256(archive).hexdigest())


class ArchiveTests(unittest.TestCase):
    def check_archive(self, extra=None):
        with tempfile.NamedTemporaryFile() as file:
            file.write(archive_bytes(extra))
            file.flush()
            validation.validate(file.name)

    def test_valid_compiled_release(self):
        self.check_archive()

    def test_rejects_symlink_hardlink_and_device(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE):
            entry = tarfile.TarInfo("dist/escape")
            entry.type, entry.linkname = kind, "/etc/gramatik-api/api.env"
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.check_archive(entry)

    def test_rejects_paths_secrets_and_duplicate_entries(self):
        for name in ("dist/../../etc/evil", "/dist/evil", "dist//evil", ".env", "deploy/evil.sh", "package.json"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check_archive(tarfile.TarInfo(name))

    def test_rejects_missing_lockfile(self):
        with tempfile.NamedTemporaryFile() as file:
            with tarfile.open(file.name, "w:gz") as archive:
                archive.addfile(tarfile.TarInfo("dist/index.js"))
            with self.assertRaises(ValueError):
                validation.validate(file.name)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.sha, self.archive = "a" * 40, archive_bytes()
        self.manifest = manifest(self.sha, self.archive)
        self.run = dict(head_sha=self.sha, event="push", head_branch="main", path=".github/workflows/ci.yml",
                        run_attempt=1, repository=dict(full_name=poll.REPOSITORY))
        self.jobs = {"jobs": [dict(name="verify", head_sha=self.sha, conclusion="success")]}

    def verify(self):
        poll.verify_ci(self.manifest, lambda url: self.jobs if "/jobs?" in url else self.run)

    def test_all_checks_and_identity_match(self):
        poll.validate_manifest(self.manifest, self.sha, self.archive)
        self.verify()

    def test_rejects_checksum_and_stale_main(self):
        with self.assertRaises(ValueError):
            poll.validate_manifest(self.manifest, self.sha, self.archive + b"changed")
        with self.assertRaises(ValueError):
            poll.validate_manifest(self.manifest, "b" * 40, self.archive)

    def test_rejects_failed_pending_or_wrong_commit_checks(self):
        for field, value in (("conclusion", "failure"), ("conclusion", None), ("head_sha", "b" * 40)):
            with self.subTest(field=field, value=value):
                self.jobs["jobs"][0] = dict(name="verify", head_sha=self.sha, conclusion="success")
                self.jobs["jobs"][0][field] = value
                with self.assertRaises(ValueError):
                    self.verify()

    def test_rejects_pr_other_workflow_branch_repo_or_attempt(self):
        for field, value in (("event", "pull_request"), ("head_branch", "feature"), ("path", "other.yml"),
                             ("run_attempt", 2), ("repository", {"full_name": "other/repo"})):
            original = self.run[field]
            self.run[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify()
            self.run[field] = original


class ReadinessTests(unittest.TestCase):
    """Run the helper's real readiness block with fixture HTTP/time commands."""

    def probe(self, ready_after, response_release):
        source = (ROOT / "deploy-release.sh").read_text()
        block = source[source.index("ready=false\n"):source.index("trap - ERR HUP INT TERM")]
        # Run identical Python checks with the current test interpreter rather
        # than repeatedly starting macOS's slower /usr/bin/python3 launcher.
        block = block.replace("/usr/bin/python3", shlex.quote(sys.executable))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            curl = root / "curl"
            curl.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " - \"$@\" <<'PY'\n" +
                            "import json, os, pathlib, sys\n" +
                            "p = pathlib.Path(os.environ['PROBE_COUNT'])\n" +
                            "n = int(p.read_text()) + 1 if p.exists() else 1\n" +
                            "p.write_text(str(n))\n" +
                            "if n < int(os.environ['READY_AFTER']): sys.exit(7)\n" +
                            "print(json.dumps({'status': 'ok', 'release': os.environ['RESPONSE_RELEASE']}))\nPY\n")
            curl.chmod(0o700)
            sleep = root / "sleep"
            sleep.write_text("#!/bin/sh\nexit 0\n")
            sleep.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       PROBE_COUNT=str(root / "count"), READY_AFTER=str(ready_after),
                       RESPONSE_RELEASE=response_release)
            # Ninety probes start up to 180 Python processes. Keep the fixture
            # watchdog tolerant of host load; the exact probe bound is asserted.
            result = subprocess.run(["bash", "-c", "set -euo pipefail\nrelease_id=" + "a" * 40 + "\n" + block],
                                    env=env, capture_output=True, text=True, timeout=120)
            return result, int((root / "count").read_text())

    def test_catalog_warmup_longer_than_thirty_seconds_can_become_ready(self):
        result, attempts = self.probe(40, "a" * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(attempts, 40)

    def test_unavailable_release_still_exhausts_a_bounded_window(self):
        result, attempts = self.probe(100, "a" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(attempts, 90)
        self.assertIn("restoring its previous release", result.stderr)

    def test_healthy_previous_commit_cannot_pass_readiness(self):
        result, attempts = self.probe(1, "b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(attempts, 90)


class PullIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.origin = self.root / "origin"
        self.origin.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Deployment fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.origin / "source").write_text("first")
        self.git("add", "source")
        self.git("commit", "-qm", "main fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        self.archive = archive_bytes()
        self.git("checkout", "-q", "--orphan", poll.BRANCH)
        self.git("rm", "-q", "-rf", ".")
        (self.origin / "release.tar.gz").write_bytes(self.archive)
        (self.origin / "manifest.json").write_text(json.dumps(manifest(self.sha, self.archive)))
        self.git("add", ".")
        self.git("commit", "-qm", "tested artifact fixture")
        self.log = self.root / "deployed"
        helper = self.root / "deployer"
        helper.write_text("#!/bin/sh\nprintf '%s\\n' \"$2\" >> \"" + str(self.log) + "\"\n")
        helper.chmod(0o700)
        self.verified = []
        self.poller = poll.Poller(state=self.root / "state", remote=str(self.origin), deployer=str(helper),
                                  verify=lambda value: self.verified.append(value["sourceCommit"]))
        self.health = patch.object(poll, "request_json", return_value={"status": "ok", "release": self.sha})
        self.health.start()

    def tearDown(self):
        self.health.stop()
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.origin, stderr=subprocess.DEVNULL).decode()

    def test_verified_release_applies_once_and_does_not_spend_api_quota_again(self):
        self.poller.tick()
        self.poller.tick()
        self.assertEqual(self.log.read_text().splitlines(), [self.sha])
        self.assertEqual(self.verified, [self.sha])

    def test_newer_untested_main_keeps_current_release(self):
        self.git("checkout", "-q", "main")
        (self.origin / "source").write_text("newer")
        self.git("commit", "-qam", "new main not yet verified")
        self.poller.tick()
        self.assertFalse(self.log.exists())
        self.assertEqual(self.verified, [])

    def test_ci_failure_does_not_execute_deployer(self):
        def reject(_):
            raise ValueError("CI failed")
        self.poller.verify = reject
        with self.assertRaises(ValueError):
            self.poller.tick()
        self.assertFalse(self.log.exists())

    def test_failed_release_is_held_until_an_explicit_retry_or_new_commit(self):
        with patch.object(poll, "request_json", return_value={"release": "b" * 40}):
            with self.assertRaises(ValueError):
                self.poller.tick()
        self.poller.tick()
        self.assertEqual(self.log.read_text().splitlines(), [self.sha])
        self.assertFalse((self.poller.state / "applied-commit").exists())


if __name__ == "__main__":
    unittest.main()
