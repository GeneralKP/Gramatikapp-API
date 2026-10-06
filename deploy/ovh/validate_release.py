#!/usr/bin/env python3
"""Validate before unprivileged extraction; reject links and archive path escapes."""
import os
import posixpath
import sys
import tarfile


def validate(path):
    if os.path.getsize(path) > 32 * 1024 * 1024:
        raise ValueError("Compressed release exceeds 32 MiB")
    seen, files, size = set(), set(), 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = member.name.rstrip("/")
            if (not name or name.startswith("/") or posixpath.normpath(name) != name
                    or any(part in (".", "..", "") for part in name.split("/"))):
                raise ValueError("Unsafe archive path")
            if name in seen or len(seen) >= 10000 or not (member.isfile() or member.isdir()):
                raise ValueError("Duplicate, linked or special archive entry")
            seen.add(name)
            if name not in ("dist", "package.json", "package-lock.json") and not name.startswith("dist/"):
                raise ValueError("Unexpected archive entry")
            if name in ("package.json", "package-lock.json") and not member.isfile():
                raise ValueError("Package metadata must be regular files")
            size += member.size
            if size > 128 * 1024 * 1024:
                raise ValueError("Expanded release exceeds 128 MiB")
            if member.isfile():
                files.add(name)
    if not {"dist/index.js", "package.json", "package-lock.json"} <= files:
        raise ValueError("Release is missing the application or lockfile")


if __name__ == "__main__":
    validate(sys.argv[1])
