"""Harbor job orchestration for tbench.

Handles JobConfig construction, hook wiring for progress display, resume
handling, and detach mode. All Harbor interaction is through the Python
library (no subprocess).
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from tbench.binary import build, compute_sha256, get_binary_path
from tbench.config import TBenchConfig, load_config
from tbench.json_formatter import json_run_response
from tbench.renderer import render_progress_bar

from harbor.job import Job, JobConfig
from harbor.models.environment_type import EnvironmentType
from harbor.models.job.config import DatasetConfig, RetryConfig, TaskConfig
from harbor.models.job.result import JobResult
from harbor.models.trial.config import AgentConfig, EnvironmentConfig
from harbor.trial.hooks import TrialHookEvent

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Progress callbacks
# ---------------------------------------------------------------------------

class ProgressCallbacks(Protocol):
    """Interface for receiving live progress updates during a Harbor run."""

    def trial_started(self, event: TrialHookEvent) -> None:
        ...

    def trial_ended(self, event: TrialHookEvent) -> None:
        ...

    def agent_started(self, event: TrialHookEvent) -> None:
        ...

    def verification_started(self, event: TrialHookEvent) -> None:
        ...

    def trial_cancelled(self, event: TrialHookEvent) -> None:
        ...


@dataclass
class SimpleCLIProgress(ProgressCallbacks):
    """Simple CLI progress that prints a Rich progress bar on every update."""

    total: int
    completed: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def _update(self) -> None:
        render_progress_bar(
            completed=self.completed,
            total=self.total,
            passed=self.passed,
            failed=self.failed,
            errors=self.errors,
        )

    def trial_started(self, event: TrialHookEvent) -> None:
        # No-op; we count completion, not starts
        pass

    def trial_ended(self, event: TrialHookEvent) -> None:
        self.completed += 1
        if event.result is not None and event.result.verifier_result is not None:
            reward = event.result.verifier_result.reward
            if reward is not None and reward > 0:
                self.passed += 1
            else:
                self.failed += 1
        elif event.result is not None and event.result.exception_info is not None:
            self.errors += 1
        else:
            # Treat no verifier result as fail
            self.failed += 1
        self._update()

    def agent_started(self, event: TrialHookEvent) -> None:
        pass

    def verification_started(self, event: TrialHookEvent) -> None:
        pass

    def trial_cancelled(self, event: TrialHookEvent) -> None:
        self.completed += 1
        self.errors += 1
        self._update()


class SilentProgress(ProgressCallbacks):
    """No-op progress callbacks (for detach mode or TUI integration)."""

    def trial_started(self, event: TrialHookEvent) -> None:
        pass

    def trial_ended(self, event: TrialHookEvent) -> None:
        pass

    def agent_started(self, event: TrialHookEvent) -> None:
        pass

    def verification_started(self, event: TrialHookEvent) -> None:
        pass

    def trial_cancelled(self, event: TrialHookEvent) -> None:
        pass


# ---------------------------------------------------------------------------
# Build JobConfig
# ---------------------------------------------------------------------------

def _build_job_config(
    config: TBenchConfig,
    env: str,
    concurrency: int,
    trials: int,
    difficulty: str | None,
    tasks: list[str] | None,
    binary_path: Path | None = None,
    binary_sha: str | None = None,
) -> JobConfig:
    """Construct a Harbor JobConfig for a tbench run.

    Args:
        config: Resolved tbench configuration.
        env: ``"local"`` or ``"modal"``.
        concurrency: Number of concurrent trials.
        trials: Number of attempts per task.
        difficulty: Optional difficulty filter (``"easy"``, ``"medium"``, ``"hard"``).
        tasks: Optional explicit task name list.
        binary_path: Path to the built Linux binary (for metadata only).
        binary_sha: SHA256 of the binary (stored in job metadata).

    Returns:
        A fully configured ``JobConfig`` ready for ``Job.create()``.
    """
    jobs_dir = Path(config.harbor.jobs_dir).expanduser().resolve()
    jobs_dir.mkdir(parents=True, exist_ok=True)

    # Environment
    env_type = EnvironmentType.MODAL if env == "modal" else EnvironmentType.DOCKER
    environment_kwargs: dict[str, Any] = {}
    mounts: list[dict[str, Any]] | None = None

    if env == "modal":
        mounts = [
            {
                "type": "volume",
                "source": config.modal.volume_name,
                "target": config.modal.binary_mount_path,
                "volume": {},
            }
        ]

    environment = EnvironmentConfig(
        type=env_type,
        mounts=mounts,
        kwargs=environment_kwargs,
    )

    # Agent
    agent = AgentConfig(
        name="magnitude",
        import_path="evals.tbench.magnitude_agent:MagnitudeAgent",
        env={
            "MAGNITUDE_API_KEY": os.environ.get("MAGNITUDE_API_KEY", ""),
        },
    )

    # Dataset
    dataset = DatasetConfig(
        name="terminal-bench",
        version="2.1",
    )

    # Tasks filter
    task_configs: list[TaskConfig] | None = None
    if tasks is not None:
        task_configs = [TaskConfig(name=t) for t in tasks]

    # Extra metadata so downstream commands can correlate by binary SHA
    extra: dict[str, Any] = {}
    if binary_sha is not None:
        extra["magnitude_binary_sha"] = binary_sha

    # Artifacts for metadata correlation
    artifacts: list[str | dict[str, Any]] = []
    if binary_sha is not None:
        artifacts.append(f"binary_sha:{binary_sha}")

    return JobConfig(
        jobs_dir=jobs_dir,
        n_attempts=trials,
        n_concurrent_trials=concurrency,
        retry=RetryConfig(max_retries=0),
        environment=environment,
        agents=[agent],
        datasets=[dataset],
        tasks=task_configs if task_configs is not None else [],
        artifacts=artifacts,
        extra=extra,
    )


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

async def run_benchmark(
    env: str | None = None,
    concurrency: int | None = None,
    trials: int | None = None,
    difficulty: str | None = None,
    tasks: list[str] | None = None,
    resume: str | None = None,
    detach: bool = False,
    *,
    progress: ProgressCallbacks | None = None,
) -> JobResult | str:
    """Run (or resume) a Harbor benchmark job and return the result.

    Args:
        env: ``"local"`` or ``"modal"``. Falls back to config default.
        concurrency: Concurrent trial count. Falls back to config default.
        trials: Number of attempts per task. Falls back to config default.
        difficulty: Filter tasks by difficulty (``"easy"``, ``"medium"``, ``"hard"``).
        tasks: Explicit task name list (mutually exclusive with *difficulty*).
        resume: Job ID to resume (e.g. ``"2026-05-20__09-15-33"``).
        detach: If ``True``, start the job and return the job ID immediately
            without waiting for completion.
        progress: Optional progress callback implementation. If ``None`` and
            *detach* is ``False``, a default ``SimpleCLIProgress`` is used.

    Returns:
        If *detach* is ``False`` — the completed ``JobResult``.
        If *detach* is ``True`` — the job ID string.

    Raises:
        FileNotFoundError: If the binary needs building but the build script
            is missing.
        RuntimeError: If Harbor raises an unrecoverable error.
    """
    config = load_config()

    env = env or config.harbor.environment
    concurrency = concurrency or config.harbor.concurrency
    trials = trials or config.tbench.default_trials

    # Ensure binary exists (auto-build or fail)
    binary_path = get_binary_path()
    if not binary_path.exists():
        logger.info("Binary not found, building...")
        binary_path = build(force=False)

    binary_sha = compute_sha256(binary_path)

    # Modal volume seed check
    if env == "modal" and not detach:
        # We can't easily check if the volume is seeded, but we can warn
        # if the user hasn't run tbench seed recently.
        logger.info(
            "Modal run requested. Ensure the volume is seeded: "
            "tbench seed --force"
        )

    # Build JobConfig
    job_config = _build_job_config(
        config=config,
        env=env,
        concurrency=concurrency,
        trials=trials,
        difficulty=difficulty,
        tasks=tasks,
        binary_path=binary_path,
        binary_sha=binary_sha,
    )

    # Create / resume job
    if resume is not None:
        logger.info("Resuming job %s", resume)
        # Harbor's Job.create doesn't take a resume arg at the Python level.
        # Resume is done by re-running the same job config in the same jobs_dir
        # with retry enabled; Harbor detects existing trial directories and skips
        # completed ones.
        job_config = job_config.model_copy(update={"retry": RetryConfig(max_retries=1)})
        job = await Job.create(job_config)
    else:
        job = await Job.create(job_config)

    # Detach mode — return job ID immediately
    if detach:
        job_id = _job_id_from_job(job)
        logger.info("Detached job started: %s", job_id)
        return job_id

    # Wire hooks
    progress = progress or SimpleCLIProgress(
        total=_estimate_total_trials(job_config, difficulty, tasks)
    )
    job.on_trial_started(lambda event: progress.trial_started(event))
    job.on_trial_ended(lambda event: progress.trial_ended(event))
    job.on_agent_started(lambda event: progress.agent_started(event))
    job.on_verification_started(lambda event: progress.verification_started(event))
    job.on_trial_cancelled(lambda event: progress.trial_cancelled(event))

    # Run
    try:
        result = await job.run()
    except Exception:
        logger.exception("Harbor job failed")
        raise

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _job_id_from_job(job: Job) -> str:
    """Best-effort extraction of the job ID from a running Job instance."""
    # Harbor exposes job_dir (Path) and id (UUID) on the Job object.
    if hasattr(job, "job_dir") and job.job_dir is not None:
        job_dir = Path(job.job_dir)
        if job_dir.exists():
            return job_dir.name
    # Fallback: most recent directory in jobs_dir
    jobs_dir = getattr(job, "jobs_dir", None)
    if jobs_dir is None:
        return "unknown"
    jobs_dir = Path(jobs_dir)
    if not jobs_dir.exists():
        return "unknown"
    dirs = sorted(
        [d.name for d in jobs_dir.iterdir() if d.is_dir()],
        reverse=True,
    )
    return dirs[0] if dirs else "unknown"


def _estimate_total_trials(
    job_config: JobConfig,
    difficulty: str | None,
    tasks: list[str] | None,
) -> int:
    """Estimate the total number of trials for progress bar sizing.

    When tasks are explicitly provided, the count is exact. When a difficulty
    filter is used we fall back to scanning Harbor's task registry. If that
    also fails we return a conservative default.
    """
    if tasks is not None:
        return len(tasks) * job_config.n_attempts

    if difficulty is not None:
        try:
            from tbench.scanner import discover_tasks

            filtered = discover_tasks(difficulty=difficulty)
            return len(filtered) * job_config.n_attempts
        except Exception:
            logger.debug("Could not discover tasks for progress estimate")

    # Conservative default for full TB2
    return 89 * job_config.n_attempts


# ---------------------------------------------------------------------------
# JSON output builder (bridges JobResult → json_formatter)
# ---------------------------------------------------------------------------

def build_run_json(
    result: JobResult,
    job_id: str,
    binary_path: Path,
    env: str = "local",
    concurrency: int = 0,
    trials: int = 0,
    task_filter: str | list[str] | None = None,
) -> dict[str, Any]:
    """Convert a Harbor ``JobResult`` into the standard ``--json`` response dict.

    This is a convenience wrapper around ``json_run_response`` so callers
    don't need to pull stats out of the Pydantic model manually.
    """
    binary_sha = compute_sha256(binary_path)
    binary_stat = binary_path.stat()
    binary_built_at = datetime.fromtimestamp(binary_stat.st_mtime, tz=timezone.utc).isoformat()

    total = result.n_total_trials
    completed = result.stats.n_completed_trials if result.stats else 0
    errors = result.stats.n_errored_trials if result.stats else 0
    passed = 0
    failed = 0

    # Count passed/failed from trial results
    for trial in result.trial_results:
        if trial.verifier_result is not None and trial.verifier_result.reward is not None:
            if trial.verifier_result.reward > 0:
                passed += 1
            else:
                failed += 1
        else:
            failed += 1

    mean_reward = 0.0
    if total > 0:
        rewards = [
            t.verifier_result.reward
            for t in result.trial_results
            if t.verifier_result is not None and t.verifier_result.reward is not None
        ]
        if rewards:
            mean_reward = sum(rewards) / total

    runtime_sec = 0
    if result.finished_at and result.started_at:
        runtime_sec = int((result.finished_at - result.started_at).total_seconds())

    # Error types
    errors_by_type: dict[str, int] = {}
    for trial in result.trial_results:
        if trial.exception_info is not None:
            exc_type = trial.exception_info.type or "Unknown"
            errors_by_type[exc_type] = errors_by_type.get(exc_type, 0) + 1

    return json_run_response(
        job_id=job_id,
        job_path=str(Path(result.trial_results[0].trial_uri).parents[2]) if result.trial_results else "",
        started_at=result.started_at.isoformat() if result.started_at else "",
        finished_at=result.finished_at.isoformat() if result.finished_at else "",
        status="complete" if result.finished_at else "partial",
        binary={
            "sha256": binary_sha,
            "path": str(binary_path),
            "built_at": binary_built_at,
        },
        configuration={
            "environment": env,
            "concurrency": concurrency,
            "trials": trials,
            "task_filter": task_filter,
        },
        outcome={
            "total": total,
            "passed": passed,
            "failed": failed,
            "errors": errors,
            "mean_reward": mean_reward,
            "runtime_sec": runtime_sec,
        },
        errors_by_type=errors_by_type,
    )
