#!/usr/bin/env python3
"""Seed a Modal volume with the Magnitude binary for TB2 evals.

Usage:
    modal run evals/tbench/seed_modal_volume.py
    modal run evals/tbench/seed_modal_volume.py --force
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

import modal

DEFAULT_VOLUME_NAME = "magnitude-binaries"
DEFAULT_BINARY_PATH = str(Path(__file__).parent / "bin" / "magnitude")
VOLUME_DIR = "/magnitude"

app = modal.App("magnitude-seeder")
vol = modal.Volume.from_name(DEFAULT_VOLUME_NAME, create_if_missing=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@app.local_entrypoint()
def main(force: bool = False):
    binary_path = Path(DEFAULT_BINARY_PATH).expanduser().resolve()
    if not binary_path.is_file():
        raise FileNotFoundError(f"Binary not found: {binary_path}")

    binary_bytes = binary_path.read_bytes()
    sha256 = sha256_file(binary_path)

    remote_binary_path = f"{VOLUME_DIR}/sha256/{sha256}/magnitude"
    remote_current_path = f"{VOLUME_DIR}/current"

    print(f"Uploading binary ({len(binary_bytes)} bytes, sha256={sha256})...", flush=True)
    with vol.batch_upload(force=force) as batch:
        batch.put_file(binary_path, remote_binary_path)
        batch.put_file(io.BytesIO(f"{sha256}\n".encode("utf-8")), remote_current_path)

    print(f"Seeded Modal volume '{DEFAULT_VOLUME_NAME}' with magnitude sha256 {sha256}")
