"""Linux binary management for tbench.

Handles building the Magnitude Linux binary via Docker, stale detection,
and seeding the Modal volume with the binary.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from tbench.config import load_config


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def get_binary_path() -> Path:
    """Return the path to the Magnitude Linux binary.

    *bin_dir* from config is resolved relative to the repository root
    (``magnitude/``, three directories above this file).
    """
    config = load_config()
    raw = config.binary.bin_dir
    # repo_root is magnitude/ — four levels above this file
    # (src/tbench/binary.py → src/ → tbench/ → evals/ → magnitude/)
    repo_root = Path(__file__).resolve().parents[4]
    # raw is relative to the repo root (e.g. "./evals/tbench/bin").
    # Strip leading "./" then join.  resolve() is safe because the joined
    # path is already absolute (repo_root is absolute).
    raw_stripped = raw.removeprefix("./")
    binary_path = (repo_root / raw_stripped / "magnitude").resolve()
    return binary_path


def compute_sha256(path: Path) -> str:
    """Return the SHA256 hex digest of the file at *path*."""
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_current_git_head() -> str | None:
    """Return the current git HEAD SHA, or None if not in a git repo."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            cwd=Path(__file__).resolve().parents[4],
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


# ---------------------------------------------------------------------------
# Stale detection
# ---------------------------------------------------------------------------

def is_stale() -> bool:
    """Check whether the binary is stale compared to the current source tree.

    A binary is considered stale when:
    * It does not exist.
    * The git HEAD has changed since the last build.
    * The recorded modification time of the source files is newer than the
      recorded build time.

    Falls back to comparing the binary's own mtime against the source tree's
    newest mtime when no build record exists.
    """
    binary_path = get_binary_path()

    if not binary_path.exists():
        return True

    record = _load_build_record()
    if record is not None:
        # Compare against recorded git HEAD
        current_head = get_current_git_head()
        if current_head is not None and record.get("git_head") != current_head:
            return True
        # Compare source mtime against build time
        current_newest_mtime = _newest_source_mtime()
        build_time = record.get("build_time")
        if current_newest_mtime is not None and build_time is not None:
            if current_newest_mtime > build_time:
                return True
        return False

    # No build record — fall back to naive mtime comparison
    binary_mtime = _file_mtime_str(binary_path)
    newest_source = _newest_source_mtime()
    if newest_source is None:
        return False
    return newest_source > binary_mtime


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build(force: bool = False) -> Path:
    """Build the Linux binary via *build-linux.sh* and return its path.

    If *force* is False and the binary is not stale, the existing binary is
    returned immediately.
    """
    binary_path = get_binary_path()

    if not force and binary_path.exists() and not is_stale():
        return binary_path

    config = load_config()
    repo_root = Path(__file__).resolve().parents[4]
    script_raw = config.binary.build_script.removeprefix("./")
    script = (repo_root / script_raw).resolve()

    if not script.exists():
        raise FileNotFoundError(f"Build script not found: {script}")

    subprocess.run(
        ["bash", str(script)],
        check=True,
        cwd=script.parent,
    )

    if not binary_path.exists():
        raise FileNotFoundError(
            f"Build script ran but binary not found at {binary_path}"
        )

    # Persist build record for future stale detection
    _save_build_record(
        {
            "git_head": get_current_git_head(),
            "build_time": _file_mtime_str(binary_path),
            "sha256": compute_sha256(binary_path),
        }
    )

    return binary_path


# ---------------------------------------------------------------------------
# Modal volume seeding
# ---------------------------------------------------------------------------

def seed_modal_volume(force: bool = False) -> None:
    """Seed the Modal volume with the current Magnitude binary.

    Runs *evals/tbench/seed_modal_volume.py* via ``modal run``.
    """
    binary_path = get_binary_path()
    if not binary_path.exists():
        raise FileNotFoundError(f"Binary not found: {binary_path}")

    repo_root = Path(__file__).resolve().parents[4]
    seeder_script = repo_root / "evals" / "tbench" / "seed_modal_volume.py"

    if not seeder_script.exists():
        raise FileNotFoundError(f"Seeder script not found: {seeder_script}")

    cmd = ["modal", "run", str(seeder_script)]
    if force:
        cmd.append("--force")

    subprocess.run(cmd, check=True, cwd=repo_root)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_build_record_path() -> Path:
    """Return the path to the build metadata JSON file."""
    return Path(__file__).parent / "_build_record.json"


def _load_build_record() -> dict | None:
    """Load the last build record, or None if missing / corrupt."""
    record_path = _get_build_record_path()
    if not record_path.exists():
        return None
    try:
        with record_path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _save_build_record(record: dict) -> None:
    """Persist build metadata for future stale detection."""
    record_path = _get_build_record_path()
    with record_path.open("w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)


def _file_mtime_str(path: Path) -> str:
    """Return ISO 8601 UTC mtime string for *path*."""
    mtime = path.stat().st_mtime
    return datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()


def _newest_source_mtime() -> str | None:
    """Return the most recent mtime among tracked source files.

    Scans the git repository for tracked files under *packages/* and *cli/*,
    which are the primary directories that affect the binary build.
    """
    repo_root = Path(__file__).resolve().parents[4]
    try:
        result = subprocess.run(
            ["git", "ls-files", "--exclude-standard"],
            capture_output=True,
            text=True,
            check=True,
            cwd=repo_root,
        )
        files = result.stdout.strip().splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None

    relevant_dirs = ("packages/", "cli/", "package.json", "tsconfig.json")
    newest: float | None = None
    for rel_path in files:
        if not rel_path.startswith(relevant_dirs):
            continue
        full_path = repo_root / rel_path
        if not full_path.exists():
            continue
        mtime = full_path.stat().st_mtime
        if newest is None or mtime > newest:
            newest = mtime

    if newest is None:
        return None
    return datetime.fromtimestamp(newest, tz=timezone.utc).isoformat()
