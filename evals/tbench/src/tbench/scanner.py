"""Filesystem scanning layer and Harbor JobScanner wrapper.

Provides thin wrappers around ``harbor.viewer.scanner.JobScanner`` plus
filesystem helpers that Harbor doesn't expose directly (task discovery,
job history navigation, trial directory parsing).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import toml
from pydantic import BaseModel, Field

from tbench.config import TBenchConfig, load_config

try:
    from harbor.models.job.config import JobConfig
    from harbor.models.job.result import JobResult
    from harbor.models.trial.result import TrialResult
    from harbor.viewer.scanner import JobScanner

    HARBOR_AVAILABLE = True
except Exception:
    HARBOR_AVAILABLE = False
    JobConfig = Any  # type: ignore[misc,assignment]
    JobResult = Any  # type: ignore[misc,assignment]
    TrialResult = Any  # type: ignore[misc,assignment]
    JobScanner = Any  # type: ignore[misc,assignment]

logger = logging.getLogger(__name__)


class JobSummary(BaseModel):
    """Filesystem-level summary of a Harbor job directory."""

    job_id: str
    job_dir_name: str
    job_path: Path
    config_path: Path
    result_path: Path
    started_at: str | None = None
    finished_at: str | None = None
    model_name: str | None = None
    task_count: int = 0
    total_trials_expected: int | None = None
    total_trials_observed: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0
    mean_reward: float | None = None
    status: str = "partial"
    eval_name: str | None = None
    task_breakdown: list[TaskAggregate] = Field(default_factory=list)
    binary_sha256: str | None = None


class TaskAggregate(BaseModel):
    """Per-task trial statistics."""

    task_name: str
    trials: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0
    mean_reward: float | None = None


class TBenchScanner:
    """Wraps ``JobScanner`` with tbench-specific helpers."""

    def __init__(self, jobs_dir: Path | None = None, config: TBenchConfig | None = None):
        self.config = config or load_config()
        if jobs_dir is not None:
            self.jobs_dir = Path(jobs_dir)
        else:
            self.jobs_dir = get_jobs_dir(self.config)
        if not HARBOR_AVAILABLE:
            raise RuntimeError(
                "Harbor is not installed. Install it with: pip install magnitude-tbench[harbor]"
            )
        self._scanner = JobScanner(self.jobs_dir)

    # ------------------------------------------------------------------
    # Passthrough to JobScanner
    # ------------------------------------------------------------------

    def list_jobs(self) -> list[str]:
        """Return job directory names, most-recent first."""
        return self._scanner.list_jobs()

    def get_job_config(self, job_name: str) -> JobConfig | None:
        """Load ``JobConfig`` for a job."""
        return self._scanner.get_job_config(job_name)

    def get_job_result(self, job_name: str) -> JobResult | None:
        """Load ``JobResult`` for a job."""
        return self._scanner.get_job_result(job_name)

    def list_trials(self, job_name: str) -> list[str]:
        """Return trial names that have a ``result.json`` on disk."""
        return self._scanner.list_trials(job_name)

    def get_trial_result(self, job_name: str, trial_name: str) -> TrialResult | None:
        """Load ``TrialResult`` for a single trial."""
        return self._scanner.get_trial_result(job_name, trial_name)

    # ------------------------------------------------------------------
    # Filesystem helpers (not in JobScanner)
    # ------------------------------------------------------------------

    def get_trial_dirs(self, job_name: str) -> list[Path]:
        """Return *all* trial directories for a job, regardless of result.json."""
        job_dir = self.jobs_dir / job_name
        if not job_dir.exists():
            return []
        return sorted(
            [d for d in job_dir.iterdir() if d.is_dir() and "__" in d.name],
            key=lambda p: p.name,
        )

    def parse_trial_dir_name(self, trial_dir_name: str) -> dict[str, str | int | None]:
        """Parse ``taskname__agentname__attempt-N`` into components.

        Returns a dict with keys ``task_name``, ``agent_name``, ``attempt``.
        If the attempt segment is missing, ``attempt`` is ``None``.
        """
        parts = trial_dir_name.split("__")
        result: dict[str, str | int | None] = {
            "task_name": parts[0],
            "agent_name": parts[1] if len(parts) > 1 else None,
            "attempt": None,
        }
        if len(parts) > 2 and parts[2].startswith("attempt-"):
            try:
                result["attempt"] = int(parts[2].split("-", 1)[1])
            except ValueError:
                result["attempt"] = None
        return result

    def get_job_dir(self, job_name: str) -> Path:
        """Return the full path to a job directory."""
        return self.jobs_dir / job_name

    def job_exists(self, job_name: str) -> bool:
        """Check whether a job directory exists on disk."""
        return (self.jobs_dir / job_name).is_dir()

    def get_binary_sha_from_config(self, job_name: str) -> str | None:
        """Extract the Magnitude binary SHA from a job's config if recorded.

        TBench stores the binary SHA in the job config's ``artifacts`` or
        ``extra`` metadata so that runs can be compared by binary version.
        If not found, returns ``None``.
        """
        config = self.get_job_config(job_name)
        if config is None:
            return None
        # Check extra kwargs first (our convention)
        if hasattr(config, "extra") and config.extra:
            extra = config.extra
            if isinstance(extra, dict):
                sha = extra.get("magnitude_binary_sha")
                if sha:
                    return str(sha)
        # Fallback: look in artifacts for a path containing the sha
        for artifact in getattr(config, "artifacts", []):
            if isinstance(artifact, dict):
                name = artifact.get("name", "")
                if "binary_sha" in name.lower():
                    return artifact.get("value")
            elif isinstance(artifact, str) and "sha" in artifact.lower():
                # artifact string might be sha-like
                return artifact
        return None

    # ------------------------------------------------------------------
    # Job history navigation
    # ------------------------------------------------------------------

    def find_latest_job(self) -> str | None:
        """Return the most recent job directory name, or ``None``."""
        jobs = self.list_jobs()
        return jobs[0] if jobs else None

    def find_latest_completed_job(self) -> str | None:
        """Return the most recent job that has ``finished_at`` set."""
        for job_name in self.list_jobs():
            result = self.get_job_result(job_name)
            if result is not None and result.finished_at is not None:
                return job_name
        return None

    def find_previous_job(
        self,
        current_job_id: str,
        binary_sha: str | None = None,
    ) -> str | None:
        """Find the previous completed job before *current_job_id*.

        If *binary_sha* is given, only consider jobs whose config records
        the same binary SHA (so you compare like-with-like).
        """
        jobs = self.list_jobs()
        try:
            idx = jobs.index(current_job_id)
        except ValueError:
            return None

        for job_name in jobs[idx + 1 :]:
            result = self.get_job_result(job_name)
            if result is None or result.finished_at is None:
                continue
            if binary_sha is not None:
                job_sha = self.get_binary_sha_from_config(job_name)
                if job_sha != binary_sha:
                    continue
            return job_name

        return None

    def find_job_with_same_binary(self, current_job_id: str) -> str | None:
        """Find the most recent *other* job that used the same binary SHA."""
        current_sha = self.get_binary_sha_from_config(current_job_id)
        if current_sha is None:
            return self.find_previous_job(current_job_id)
        return self.find_previous_job(current_job_id, binary_sha=current_sha)

    # ------------------------------------------------------------------
    # Task discovery
    # ------------------------------------------------------------------

    def discover_tasks(
        self,
        difficulty: str | None = None,
        category: str | None = None,
    ) -> list[dict[str, Any]]:
        """Scan ``~/.cache/harbor/tasks/`` for task.toml files.

        Each task directory is laid out as
        ``~/.cache/harbor/tasks/<hash>/<task-name>/task.toml``.

        Returns a list of dicts with keys ``name``, ``difficulty``,
        ``category``, ``path``, ``hash``, ``timeout_sec``, and
        ``expert_time_estimate_min``.

        *difficulty* and *category* filter the results when provided.
        """
        tasks_dir = Path.home() / ".cache" / "harbor" / "tasks"
        if not tasks_dir.exists():
            logger.warning("Harbor tasks directory not found: %s", tasks_dir)
            return []

        tasks: list[dict[str, Any]] = []
        for hash_dir in tasks_dir.iterdir():
            if not hash_dir.is_dir():
                continue
            for task_dir in hash_dir.iterdir():
                if not task_dir.is_dir():
                    continue
                toml_path = task_dir / "task.toml"
                if not toml_path.exists():
                    continue
                try:
                    data = toml.load(toml_path)
                except Exception as exc:
                    logger.debug("Skipping unreadable task.toml %s: %s", toml_path, exc)
                    continue

                metadata = data.get("metadata", {})
                # Load instruction.md for description
                instruction_path = task_dir / "instruction.md"
                instruction = ""
                description = ""
                if instruction_path.exists():
                    try:
                        instruction = instruction_path.read_text(encoding="utf-8", errors="replace")
                        # First non-empty line as short description
                        for line in instruction.splitlines():
                            stripped = line.strip()
                            if stripped:
                                description = stripped[:200]
                                break
                    except OSError:
                        pass

                # Tags
                tags = metadata.get("tags", [])

                record = {
                    "name": task_dir.name,
                    "difficulty": metadata.get("difficulty"),
                    "category": metadata.get("category"),
                    "path": str(task_dir),
                    "hash": hash_dir.name,
                    "timeout_sec": data.get("verifier", {}).get("timeout_sec")
                    or data.get("agent", {}).get("timeout_sec"),
                    "expert_time_estimate_min": metadata.get(
                        "expert_time_estimate_min"
                    ),
                    "tags": tags,
                    "description": description,
                    "instruction": instruction,
                    "author": metadata.get("author_name"),
                    "docker_image": data.get("environment", {}).get("docker_image"),
                }

                if difficulty is not None and record["difficulty"] != difficulty:
                    continue
                if category is not None and record["category"] != category:
                    continue

                tasks.append(record)

        # Sort by name for stable output
        tasks.sort(key=lambda t: t["name"])
        return tasks


# ------------------------------------------------------------------
# Standalone helpers (can be used without instantiating TBenchScanner)
# ------------------------------------------------------------------


def _find_project_root() -> Path:
    """Walk up from CWD to find the git project root (directory with .git)."""
    candidate = Path.cwd()
    for _ in range(20):
        if (candidate / ".git").exists():
            return candidate
        parent = candidate.parent
        if parent == candidate:
            break
        candidate = parent
    # Fallback: CWD
    return Path.cwd()


def get_jobs_dir(config: TBenchConfig | None = None) -> Path:
    """Resolve the jobs directory from config, env, or default.

    Relative paths are resolved from the project root (directory with .git).
    """
    cfg = config or load_config()
    jobs_dir = Path(cfg.harbor.jobs_dir)
    # Allow env override
    env_dir = os.environ.get("TBENCH_JOBS_DIR")
    if env_dir:
        jobs_dir = Path(env_dir)
    if not jobs_dir.is_absolute():
        jobs_dir = _find_project_root() / jobs_dir
    return jobs_dir.expanduser().resolve()


def discover_tasks(
    difficulty: str | None = None,
    category: str | None = None,
    tasks_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Standalone version of task discovery.

    See :meth:`TBenchScanner.discover_tasks` for details.
    """
    if tasks_dir is None:
        tasks_dir = Path.home() / ".cache" / "harbor" / "tasks"
    if not tasks_dir.exists():
        logger.warning("Harbor tasks directory not found: %s", tasks_dir)
        return []

    tasks: list[dict[str, Any]] = []
    for hash_dir in tasks_dir.iterdir():
        if not hash_dir.is_dir():
            continue
        for task_dir in hash_dir.iterdir():
            if not task_dir.is_dir():
                continue
            toml_path = task_dir / "task.toml"
            if not toml_path.exists():
                continue
            try:
                data = toml.load(toml_path)
            except Exception as exc:
                logger.debug("Skipping unreadable task.toml %s: %s", toml_path, exc)
                continue

            metadata = data.get("metadata", {})
            # Load instruction.md for description
            instruction_path = task_dir / "instruction.md"
            instruction = ""
            description = ""
            if instruction_path.exists():
                try:
                    instruction = instruction_path.read_text(encoding="utf-8", errors="replace")
                    for line in instruction.splitlines():
                        stripped = line.strip()
                        if stripped:
                            description = stripped[:200]
                            break
                except OSError:
                    pass

            tags = metadata.get("tags", [])

            record = {
                "name": task_dir.name,
                "difficulty": metadata.get("difficulty"),
                "category": metadata.get("category"),
                "path": str(task_dir),
                "hash": hash_dir.name,
                "timeout_sec": data.get("verifier", {}).get("timeout_sec")
                or data.get("agent", {}).get("timeout_sec"),
                "expert_time_estimate_min": metadata.get("expert_time_estimate_min"),
                "tags": tags,
                "description": description,
                "instruction": instruction,
                "author": metadata.get("author_name"),
                "docker_image": data.get("environment", {}).get("docker_image"),
            }

            if difficulty is not None and record["difficulty"] != difficulty:
                continue
            if category is not None and record["category"] != category:
                continue

            tasks.append(record)

    tasks.sort(key=lambda t: t["name"])
    return tasks


def find_latest_job(jobs_dir: Path | str | None = None) -> str | None:
    """Return the most recent job directory name."""
    if jobs_dir is None:
        jobs_dir = get_jobs_dir()
    else:
        jobs_dir = Path(jobs_dir)
    if not jobs_dir.exists():
        return None
    jobs = sorted(
        [d.name for d in jobs_dir.iterdir() if d.is_dir()],
        reverse=True,
    )
    return jobs[0] if jobs else None


def find_previous_job(
    jobs_dir: Path | str,
    current_job_id: str,
    binary_sha: str | None = None,
) -> str | None:
    """Find the previous completed job before *current_job_id*.

    If *binary_sha* is given, only consider jobs whose config records
    the same binary SHA.
    """
    if not HARBOR_AVAILABLE:
        # Fallback: naive filesystem scan without JobScanner
        jobs_dir = Path(jobs_dir)
        all_jobs = sorted(
            [d.name for d in jobs_dir.iterdir() if d.is_dir()],
            reverse=True,
        )
        try:
            idx = all_jobs.index(current_job_id)
        except ValueError:
            return None
        for job_name in all_jobs[idx + 1 :]:
            result_path = jobs_dir / job_name / "result.json"
            if result_path.exists():
                # Without Harbor we can't check binary SHA easily, so skip that
                # filter when Harbor is unavailable.
                if binary_sha is None:
                    return job_name
        return None

    scanner = TBenchScanner(jobs_dir)
    return scanner.find_previous_job(current_job_id, binary_sha=binary_sha)


def read_job_config(job_path: Path) -> dict[str, Any] | None:
    """Read config.json from a job directory."""
    path = job_path / "config.json"
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)  # type: ignore[no-any-return]
    except (OSError, json.JSONDecodeError):
        return None


def read_job_result(job_path: Path) -> dict[str, Any] | None:
    """Read result.json from a job directory."""
    path = job_path / "result.json"
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)  # type: ignore[no-any-return]
    except (OSError, json.JSONDecodeError):
        return None


def read_trial_result(trial_path: Path) -> dict[str, Any] | None:
    """Read result.json from a trial directory."""
    path = trial_path / "result.json"
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)  # type: ignore[no-any-return]
    except (OSError, json.JSONDecodeError):
        return None


def trial_has_artifact(trial_path: Path, artifact: str) -> bool:
    """Check whether a relative artifact path exists inside a trial directory."""
    return (trial_path / artifact).exists()


def scan_jobs(
    jobs_dir: Path | None = None,
    completed_only: bool = False,
) -> list[JobSummary]:
    """Scan all job directories and return summaries (newest first)."""
    jobs_dir = jobs_dir or get_jobs_dir()
    dirs = list_job_directories(jobs_dir)
    summaries: list[JobSummary] = []
    for d in dirs:
        summary = summarize_job(jobs_dir / d)
        if summary is None:
            continue
        if completed_only and summary.status != "complete":
            continue
        summaries.append(summary)
    return summaries


def summarize_job(job_path: Path) -> JobSummary | None:
    """Build a rich JobSummary from a Harbor job directory.

    Uses filesystem-level parsing so that it works even when Harbor's
    JobScanner cannot parse a particular job version.
    """
    job_dir_name = job_path.name
    config = read_job_config(job_path)
    result_path = job_path / "result.json"
    result = None
    if result_path.exists():
        try:
            with result_path.open("r", encoding="utf-8") as f:
                result = json.load(f)
        except (OSError, json.JSONDecodeError):
            result = None

    meta_path = job_path / "magnitude-meta.json"
    meta = None
    if meta_path.exists():
        try:
            with meta_path.open("r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, json.JSONDecodeError):
            meta = None

    model_name = None
    if config and isinstance(config.get("agents"), list) and len(config["agents"]) > 0:
        model_name = config["agents"][0].get("model_name")

    # If there's literally no data, skip
    if not config and not result and not meta:
        return None

    task_map: dict[str, TaskAggregate] = {}
    passed = 0
    failed = 0
    errors = result.get("stats", {}).get("n_errors", 0) if result else 0
    mean_reward: float | None = None
    eval_name: str | None = None

    if result:
        evals = result.get("stats", {}).get("evals", {})
        if evals:
            eval_name = next(iter(evals.keys()), None)

        aggregate_reward_sum = 0.0
        aggregate_reward_count = 0

        for eval_name_inner, eval_result in evals.items():
            reward_stats = eval_result.get("reward_stats", {}).get("reward", {})
            exception_stats = eval_result.get("exception_stats", {})

            # Build exception-by-trial map
            exception_by_trial: dict[str, str] = {}
            for exc_type, trial_names in exception_stats.items():
                for tn in trial_names:
                    exception_by_trial[tn] = exc_type

            for reward_str, trial_names in reward_stats.items():
                try:
                    reward = float(reward_str)
                except ValueError:
                    continue
                for trial_name in trial_names:
                    task_name = parse_trial_dir_name(trial_name).get("task_name", trial_name)
                    current = task_map.get(task_name)
                    if current is None:
                        current = TaskAggregate(task_name=task_name)
                        task_map[task_name] = current
                    current.trials += 1
                    current.mean_reward = (
                        ((current.mean_reward or 0.0) * (current.trials - 1) + reward)
                        / current.trials
                    )
                    if trial_name in exception_by_trial:
                        current.errors += 1
                    if reward >= 1.0:
                        current.passed += 1
                        passed += 1
                    else:
                        current.failed += 1
                        failed += 1
                    aggregate_reward_sum += reward
                    aggregate_reward_count += 1

        if aggregate_reward_count > 0:
            mean_reward = aggregate_reward_sum / aggregate_reward_count
        else:
            metrics = eval_result.get("metrics", []) if "eval_result" in dir() else []
            if metrics and len(metrics) > 0:
                mean_reward = metrics[0].get("mean")

    # Determine status
    status = "partial"
    if not result:
        status = "partial"
    elif result.get("finished_at") is None:
        status = "in-progress"
    elif result.get("stats", {}).get("n_trials", 0) >= result.get("n_total_trials", 0):
        status = "complete"
    else:
        status = "partial"

    total_trials_observed = result.get("stats", {}).get("n_trials", 0) if result else 0
    task_count = len(task_map)

    # Compute total trials from datasets if result is missing
    if task_count == 0 and config and isinstance(config.get("datasets"), list):
        task_count = sum(
            len(d.get("task_names", [])) for d in config["datasets"]
            if isinstance(d.get("task_names"), list)
        )

    return JobSummary(
        job_id=result.get("id") if result else (config.get("job_name") if config else job_dir_name),
        job_dir_name=job_dir_name,
        job_path=job_path,
        config_path=job_path / "config.json",
        result_path=result_path,
        started_at=result.get("started_at") if result else None,
        finished_at=result.get("finished_at") if result else None,
        model_name=model_name,
        task_count=task_count,
        total_trials_expected=result.get("n_total_trials") if result else None,
        total_trials_observed=total_trials_observed,
        passed=passed,
        failed=failed,
        errors=errors,
        mean_reward=mean_reward,
        status=status,
        eval_name=eval_name,
        task_breakdown=sorted(task_map.values(), key=lambda t: t.task_name),
        binary_sha256=meta.get("sha256") if meta else None,
    )


def list_job_directories(jobs_dir: Path | None = None) -> list[str]:
    """Return a sorted list of job directory names (newest first)."""
    jobs_dir = jobs_dir or get_jobs_dir()
    if not jobs_dir.is_dir():
        return []
    dirs = [d.name for d in jobs_dir.iterdir() if d.is_dir()]
    # Harbor uses timestamps like 2026-05-20__09-15-33 — reverse sort = newest first
    dirs.sort(reverse=True)
    return dirs


def get_trial_directories(jobs_dir: Path | str, job_name: str) -> list[Path]:
    """Return all trial directories for a job (raw filesystem)."""
    job_dir = Path(jobs_dir) / job_name
    if not job_dir.exists():
        return []
    return sorted(
        [d for d in job_dir.iterdir() if d.is_dir() and "__" in d.name],
        key=lambda p: p.name,
    )


def parse_trial_dir_name(trial_dir_name: str) -> dict[str, str | int | None]:
    """Parse ``taskname__agentname__attempt-N`` into components.

    Returns ``task_name``, ``agent_name``, and ``attempt``.
    """
    parts = trial_dir_name.split("__")
    result: dict[str, str | int | None] = {
        "task_name": parts[0],
        "agent_name": parts[1] if len(parts) > 1 else None,
        "attempt": None,
    }
    if len(parts) > 2 and parts[2].startswith("attempt-"):
        try:
            result["attempt"] = int(parts[2].split("-", 1)[1])
        except ValueError:
            result["attempt"] = None
    return result
