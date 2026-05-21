"""Configuration resolution for tbench.

Priority: CLI flags → .tbench.toml (project root) → ~/.tbench.toml → env vars → defaults.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import toml
from pydantic import BaseModel


class HarborConfig(BaseModel):
    jobs_dir: str = "./jobs"
    environment: str = "local"  # "local" | "modal"
    concurrency: int = 4


class TBenchSettings(BaseModel):
    default_trials: int = 1


class ModalConfig(BaseModel):
    volume_name: str = "magnitude-binaries"
    binary_mount_path: str = "/magnitude-binaries"


class BinaryConfig(BaseModel):
    auto_check: bool = True
    build_script: str = "./evals/tbench/build-linux.sh"
    bin_dir: str = "./evals/tbench/bin"


class TBenchConfig(BaseModel):
    harbor: HarborConfig = HarborConfig()
    tbench: TBenchSettings = TBenchSettings()
    modal: ModalConfig = ModalConfig()
    binary: BinaryConfig = BinaryConfig()


DEFAULT_CONFIG = TBenchConfig()


def _find_config_files() -> list[Path]:
    """Find .tbench.toml files in priority order (project root first, then home)."""
    files: list[Path] = []
    project_config = Path.cwd() / ".tbench.toml"
    if project_config.exists():
        files.append(project_config)
    home_config = Path.home() / ".tbench.toml"
    if home_config.exists():
        files.append(home_config)
    return files


def _load_toml(path: Path) -> dict[str, Any]:
    """Load a TOML file, returning empty dict on failure."""
    try:
        return toml.load(path)
    except Exception:
        return {}


def _apply_env_overrides(config: TBenchConfig) -> TBenchConfig:
    """Apply TBENCH_* environment variable overrides."""
    overrides: dict[str, Any] = {}

    env_map = {
        "TBENCH_JOBS_DIR": ("harbor", "jobs_dir"),
        "TBENCH_ENVIRONMENT": ("harbor", "environment"),
        "TBENCH_CONCURRENCY": ("harbor", "concurrency"),
        "TBENCH_DEFAULT_TRIALS": ("tbench", "default_trials"),
        "TBENCH_MODAL_VOLUME": ("modal", "volume_name"),
    }

    for env_key, (section, field) in env_map.items():
        val = os.environ.get(env_key)
        if val is not None:
            overrides.setdefault(section, {})[field] = val

    if overrides:
        data = config.model_dump()
        for section, fields in overrides.items():
            if section in data:
                data[section].update(fields)
        return TBenchConfig(**data)

    return config


def load_config() -> TBenchConfig:
    """Load configuration from all sources."""
    # Start with defaults
    merged: dict[str, Any] = {}

    # Layer TOML configs (project root first, then home — home overrides project)
    for config_file in _find_config_files():
        toml_data = _load_toml(config_file)
        for key, value in toml_data.items():
            if isinstance(value, dict):
                merged.setdefault(key, {}).update(value)
            else:
                merged[key] = value

    config = TBenchConfig(**merged) if merged else DEFAULT_CONFIG

    # Apply env var overrides
    config = _apply_env_overrides(config)

    return config
