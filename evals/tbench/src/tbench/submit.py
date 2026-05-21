"""Leaderboard validation and packaging for tbench.

Ports the validation logic from the old ``jobs.ts`` into Python.
Provides single-job validation, multi-job submission validation, and
packaging with a generated ``metadata.yaml``.
"""

from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from tbench.scanner import (
    JobSummary,
    get_jobs_dir,
    get_trial_directories,
    parse_trial_dir_name,
    read_job_config,
    read_trial_result,
    trial_has_artifact,
    scan_jobs,
    TaskAggregate,
)


def extract_task_name_from_trial_dir(dir_name: str | Path) -> str:
    """Extract the task name from a trial directory name.

    Harbor names trial directories like ``fix-git__agent__attempt-1``.
    """
    name = str(dir_name) if isinstance(dir_name, Path) else dir_name
    return parse_trial_dir_name(name).get("task_name", name)
from tbench.json_formatter import json_meta


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class IssueSeverity:
    ERROR = "error"
    WARNING = "warning"


class IssueCode:
    MISSING_META = "MISSING_META"
    HASH_MISMATCH = "HASH_MISMATCH"
    TIMEOUT_MULTIPLIER = "TIMEOUT_MULTIPLIER"
    AGENT_TIMEOUT_OVERRIDE = "AGENT_TIMEOUT_OVERRIDE"
    VERIFIER_TIMEOUT_OVERRIDE = "VERIFIER_TIMEOUT_OVERRIDE"
    RESOURCE_OVERRIDE = "RESOURCE_OVERRIDE"
    MISSING_TRIAL_RESULT = "MISSING_TRIAL_RESULT"
    MISSING_TRIAL_ARTIFACTS = "MISSING_TRIAL_ARTIFACTS"
    LOW_COVERAGE = "LOW_COVERAGE"
    MODEL_MISMATCH = "MODEL_MISMATCH"
    INCOMPLETE_JOB = "INCOMPLETE_JOB"


class Issue(BaseModel):
    """A single validation issue (error or warning)."""

    severity: str = Field(..., description="error or warning")
    code: str = Field(..., description="IssueCode constant")
    message: str
    job_id: str | None = None
    task_name: str | None = None
    trial_dir: str | None = None


class CoverageRow(BaseModel):
    """Per-task trial coverage summary."""

    task_name: str
    trials: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0


class ValidationResult(BaseModel):
    """Result of validating one or more jobs for submission."""

    issues: list[Issue] = Field(default_factory=list)
    coverage: list[CoverageRow] = Field(default_factory=list)
    binary_hashes: list[str] = Field(default_factory=list)
    model_name: str | None = None
    selected_jobs: list[JobSummary] = Field(default_factory=list)
    valid: bool = Field(default=False, description="True if no hard errors")

    def add_issue(self, issue: Issue) -> None:
        self.issues.append(issue)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == IssueSeverity.ERROR]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == IssueSeverity.WARNING]


# ---------------------------------------------------------------------------
# Single-job validation
# ---------------------------------------------------------------------------

_REQUIRED_TRIAL_ARTIFACTS = [
    "config.json",
    "result.json",
    "trial.log",
    "agent/magnitude.txt",
]

_RECOMMENDED_TRIAL_ARTIFACTS = [
    "verifier/reward.txt",
    "verifier/test-stdout.txt",
    "verifier/ctrf.json",
]


def validate_job(scanner: Any, job_name: str) -> ValidationResult:
    """Validate a single job for leaderboard submission.

    Args:
        scanner: Harbor scanner or any object with a ``get_job_result`` method.
        job_name: Harbor job directory name (e.g. ``2026-05-20__09-15-33``).

    Returns:
        ValidationResult with issues and coverage info for this job.
    """
    jobs_dir = get_jobs_dir()
    job_path = jobs_dir / job_name

    result = ValidationResult()

    # Attempt to get a JobSummary for the job
    # scanner is unused for single-job validation since we read directly from disk,
    # but we keep the signature consistent with the design.
    summary: JobSummary | None = None
    for s in scan_jobs(jobs_dir):
        if s.job_dir_name == job_name:
            summary = s
            break

    if summary is None:
        result.add_issue(
            Issue(
                severity=IssueSeverity.ERROR,
                code=IssueCode.INCOMPLETE_JOB,
                message=f"Job directory not found or unreadable: {job_name}",
                job_id=job_name,
            )
        )
        return result

    config = read_job_config(job_path)

    # --- binary hash check (via magnitude-meta.json) ---
    meta_path = job_path / "magnitude-meta.json"
    if not meta_path.exists():
        result.add_issue(
            Issue(
                severity=IssueSeverity.ERROR,
                code=IssueCode.MISSING_META,
                message="Missing or invalid magnitude-meta.json (no binary hash recorded)",
                job_id=job_name,
            )
        )

    # --- timeout_multiplier == 1.0 ---
    if config:
        timeout_multiplier = config.get("timeout_multiplier")
        if timeout_multiplier != 1.0:
            result.add_issue(
                Issue(
                    severity=IssueSeverity.ERROR,
                    code=IssueCode.TIMEOUT_MULTIPLIER,
                    message=f"timeout_multiplier must equal 1.0, got {timeout_multiplier!r}",
                    job_id=job_name,
                )
            )

    # --- no agent timeout overrides ---
    if config and isinstance(config.get("agents"), list):
        for agent in config["agents"]:
            if agent.get("override_timeout_sec") is not None or agent.get("max_timeout_sec") is not None:
                result.add_issue(
                    Issue(
                        severity=IssueSeverity.ERROR,
                        code=IssueCode.AGENT_TIMEOUT_OVERRIDE,
                        message="Agent timeout overrides (override_timeout_sec / max_timeout_sec) are not allowed",
                        job_id=job_name,
                    )
                )
                break

    # --- no verifier timeout overrides ---
    if config:
        verifier = config.get("verifier", {})
        if verifier.get("override_timeout_sec") is not None or verifier.get("max_timeout_sec") is not None:
            result.add_issue(
                Issue(
                    severity=IssueSeverity.ERROR,
                    code=IssueCode.VERIFIER_TIMEOUT_OVERRIDE,
                    message="Verifier timeout overrides (override_timeout_sec / max_timeout_sec) are not allowed",
                    job_id=job_name,
                )
            )

    # --- no resource overrides ---
    if config:
        env = config.get("environment", {})
        if (
            env.get("override_cpus") is not None
            or env.get("override_memory_mb") is not None
            or env.get("override_storage_mb") is not None
        ):
            result.add_issue(
                Issue(
                    severity=IssueSeverity.ERROR,
                    code=IssueCode.RESOURCE_OVERRIDE,
                    message="Environment resource overrides (override_cpus / override_memory_mb / override_storage_mb) are not allowed",
                    job_id=job_name,
                )
            )

    # --- job status must be complete ---
    if summary.status != "complete":
        result.add_issue(
            Issue(
                severity=IssueSeverity.ERROR,
                code=IssueCode.INCOMPLETE_JOB,
                message=f"Job status is {summary.status}, must be complete",
                job_id=job_name,
            )
        )

    # --- trial-level checks ---
    trial_dirs = get_trial_directories(jobs_dir, job_name)
    for trial_dir in trial_dirs:
        trial_path = job_path / trial_dir
        trial_result = read_trial_result(trial_path)
        task_name = extract_task_name_from_trial_dir(trial_dir)

        if trial_result is None:
            result.add_issue(
                Issue(
                    severity=IssueSeverity.ERROR,
                    code=IssueCode.MISSING_TRIAL_RESULT,
                    message="Missing or invalid trial result.json",
                    job_id=job_name,
                    task_name=task_name,
                    trial_dir=str(trial_dir),
                )
            )

        for artifact in _REQUIRED_TRIAL_ARTIFACTS:
            if not trial_has_artifact(trial_path, artifact):
                result.add_issue(
                    Issue(
                        severity=IssueSeverity.ERROR,
                        code=IssueCode.MISSING_TRIAL_ARTIFACTS,
                        message=f"Missing required artifact: {artifact}",
                        job_id=job_name,
                        task_name=task_name,
                        trial_dir=str(trial_dir),
                    )
                )

        # Recommended artifacts — only warn if ALL are missing
        missing_recommended = [
            a for a in _RECOMMENDED_TRIAL_ARTIFACTS if not trial_has_artifact(trial_path, a)
        ]
        if len(missing_recommended) == len(_RECOMMENDED_TRIAL_ARTIFACTS):
            result.add_issue(
                Issue(
                    severity=IssueSeverity.WARNING,
                    code=IssueCode.MISSING_TRIAL_ARTIFACTS,
                    message="Missing verifier artifacts (reward.txt, test-stdout.txt, ctrf.json)",
                    job_id=job_name,
                    task_name=task_name,
                    trial_dir=str(trial_dir),
                )
            )

    # --- coverage check (per-task minimum 5 trials) ---
    for task in summary.task_breakdown:
        if task.trials < 5:
            result.add_issue(
                Issue(
                    severity=IssueSeverity.WARNING,
                    code=IssueCode.LOW_COVERAGE,
                    message=f"Task {task.task_name} has only {task.trials} trial(s); 5 required for leaderboard",
                    job_id=job_name,
                    task_name=task.task_name,
                )
            )

    result.coverage = [
        CoverageRow(
            task_name=t.task_name,
            trials=t.trials,
            passed=t.passed,
            failed=t.failed,
            errors=t.errors,
        )
        for t in summary.task_breakdown
    ]

    result.selected_jobs = [summary]
    result.binary_hashes = [summary.binary_sha256] if summary.binary_sha256 else []
    result.model_name = summary.model_name
    result.valid = len(result.errors) == 0

    return result


# ---------------------------------------------------------------------------
# Multi-job submission validation
# ---------------------------------------------------------------------------

def validate_submission(
    scanner: Any,
    job_names: list[str],
    force: bool = False,
) -> ValidationResult:
    """Validate a set of jobs for leaderboard submission.

    Performs per-job validation, then cross-job checks:
    - All jobs must have the same binary hash (unless *force*).
    - All jobs must have the same model name.
    - Minimum 5 trials per task across the combined set.

    Args:
        scanner: Harbor scanner (unused, kept for API consistency).
        job_names: List of job directory names to validate together.
        force: If True, hash mismatches become warnings instead of errors.

    Returns:
        ValidationResult with all issues, combined coverage, and metadata.
    """
    result = ValidationResult()
    coverage_map: dict[str, CoverageRow] = {}
    model_names: set[str] = set()
    binary_hashes: set[str] = set()
    selected_jobs: list[JobSummary] = []

    jobs_dir = get_jobs_dir()

    for name in job_names:
        job_result = validate_job(scanner, name)
        result.issues.extend(job_result.issues)
        selected_jobs.extend(job_result.selected_jobs)
        if job_result.model_name:
            model_names.add(job_result.model_name)
        for h in job_result.binary_hashes:
            if h:
                binary_hashes.add(h)

        # Aggregate coverage
        for row in job_result.coverage:
            existing = coverage_map.get(row.task_name)
            if existing is None:
                coverage_map[row.task_name] = row
            else:
                existing.trials += row.trials
                existing.passed += row.passed
                existing.failed += row.failed
                existing.errors += row.errors

    # --- cross-job model check ---
    if len(model_names) > 1:
        result.add_issue(
            Issue(
                severity=IssueSeverity.ERROR,
                code=IssueCode.MODEL_MISMATCH,
                message=f"Selected jobs have different model names: {', '.join(sorted(model_names))}",
            )
        )

    # --- cross-job hash check ---
    if len(binary_hashes) > 1:
        severity = IssueSeverity.WARNING if force else IssueSeverity.ERROR
        result.add_issue(
            Issue(
                severity=severity,
                code=IssueCode.HASH_MISMATCH,
                message=f"Selected jobs have different binary hashes: {', '.join(h[:12] for h in sorted(binary_hashes))}",
            )
        )

    # --- combined coverage check (5 trials per task) ---
    combined_coverage = sorted(coverage_map.values(), key=lambda r: r.task_name)
    for row in combined_coverage:
        if row.trials < 5:
            # Only add if not already reported by validate_job
            already_reported = any(
                i.code == IssueCode.LOW_COVERAGE and i.task_name == row.task_name
                for i in result.issues
            )
            if not already_reported:
                result.add_issue(
                    Issue(
                        severity=IssueSeverity.WARNING,
                        code=IssueCode.LOW_COVERAGE,
                        message=f"Task {row.task_name} has only {row.trials} trial(s) across all selected jobs; 5 required for leaderboard",
                        task_name=row.task_name,
                    )
                )

    result.coverage = combined_coverage
    result.selected_jobs = selected_jobs
    result.model_name = next(iter(model_names)) if len(model_names) == 1 else None
    result.binary_hashes = sorted(binary_hashes)
    result.valid = len(result.errors) == 0

    return result


# ---------------------------------------------------------------------------
# Packaging
# ---------------------------------------------------------------------------

def package_submission(
    scanner: Any,
    job_names: list[str],
    output_dir: Path,
) -> Path:
    """Copy and package jobs into a submission directory with metadata.yaml.

    Args:
        scanner: Harbor scanner (unused, kept for API consistency).
        job_names: Job directory names to include.
        output_dir: Destination directory for the submission package.

    Returns:
        Path to the created submission directory.
    """
    jobs_dir = get_jobs_dir()
    output_dir = Path(output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    # Copy each job directory into the output
    for name in job_names:
        src = jobs_dir / name
        dst = output_dir / name
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)

    # Determine metadata
    summaries: list[JobSummary] = []
    model_names: set[str] = set()
    binary_hashes: set[str] = set()
    for name in job_names:
        for s in scan_jobs(jobs_dir):
            if s.job_dir_name == name:
                summaries.append(s)
                if s.model_name:
                    model_names.add(s.model_name)
                if s.binary_sha256:
                    binary_hashes.add(s.binary_sha256)
                break

    model_name = next(iter(model_names)) if len(model_names) == 1 else (summaries[0].model_name if summaries else None)
    binary_hash = next(iter(binary_hashes)) if len(binary_hashes) == 1 else None

    metadata = generate_metadata_yaml(
        params={
            "model_name": model_name or "unknown",
            "binary_hash": binary_hash,
            "job_ids": job_names,
            "created_at": datetime.now(tz=timezone.utc).isoformat(),
        }
    )

    meta_path = output_dir / "metadata.yaml"
    meta_path.write_text(metadata, encoding="utf-8")

    return output_dir


# ---------------------------------------------------------------------------
# Metadata YAML generation
# ---------------------------------------------------------------------------

def _title_case(value: str) -> str:
    # Normalize separators to spaces, then capitalize each word
    normalized = value.replace("-", " ").replace("_", " ")
    return " ".join(
        part.capitalize() for part in normalized.split()
        if part
    )


def _humanize_provider(provider: str) -> str:
    mapping: dict[str, str] = {
        "anthropic": "Anthropic",
        "openai": "OpenAI",
        "openrouter": "OpenRouter",
        "google": "Google",
    }
    return mapping.get(provider.lower(), _title_case(provider))


def _humanize_model(model: str) -> str:
    mapping: dict[str, str] = {
        "claude-sonnet-4-6": "Claude Sonnet 4 (6)",
        "gpt-5.4": "GPT-5.4",
        "gpt-5.3-codex": "GPT-5.3 Codex",
        "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
    }
    return mapping.get(model.lower(), model)


def generate_metadata_yaml(params: dict[str, Any]) -> str:
    """Generate the metadata.yaml content for a leaderboard submission.

    Args:
        params: Dict with keys ``model_name``, ``binary_hash`` (optional),
            ``job_ids``, and ``created_at``.

    Returns:
        The metadata.yaml file contents as a string.
    """
    model_name = params["model_name"]
    binary_hash = params.get("binary_hash")
    job_ids = params["job_ids"]
    created_at = params["created_at"]

    # Split provider / model — provider is everything before the first "/"
    if "/" in model_name:
        provider, model = model_name.split("/", 1)
    else:
        provider = model_name
        model = model_name

    lines = [
        'agent_url: "https://github.com/magnitude-dev/magnitude"',
        'agent_display_name: "Magnitude"',
        'agent_org_display_name: "Magnitude"',
        "",
        "models:",
        f'  - model_name: "{model}"',
        f'    model_provider: "{provider}"',
        f'    model_display_name: "{_humanize_model(model)}"',
        f'    model_org_display_name: "{_humanize_provider(provider)}"',
        "",
        "# Magnitude submission metadata",
        f'created_at: "{created_at}"',
    ]

    if binary_hash:
        lines.append(f'binary_sha256: "{binary_hash}"')
    else:
        lines.append("binary_sha256: null")
        lines.append('binary_sha256_note: "multiple binary hashes across selected jobs"')

    lines.append("source_jobs:")
    for job_id in job_ids:
        lines.append(f'  - "{job_id}"')

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# JSON formatter integration
# ---------------------------------------------------------------------------

def json_submit_response(
    job_id: str,
    valid: bool,
    checks: dict[str, Any],
    warnings: list[dict[str, Any]],
    errors: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the JSON dict for ``tbench submit --validate --json``.

    Re-uses the pattern from ``json_formatter.py`` for consistency.
    """
    err_count = len(errors)
    warn_count = len(warnings)
    summary = f"Submission validation for {job_id}: "
    if valid and not warn_count:
        summary += "Ready to submit. All checks passed."
    elif valid:
        summary += f"Valid with {warn_count} warning(s)."
    else:
        summary += f"Invalid — {err_count} error(s), {warn_count} warning(s)."

    return {
        "meta": json_meta("submit --validate", job_id=job_id),
        "summary": summary,
        "valid": valid,
        "checks": checks,
        "warnings": warnings,
        "errors": errors,
    }
