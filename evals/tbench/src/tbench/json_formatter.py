"""LLM-mode JSON constructors for tbench commands.

Every JSON response shares a consistent structure:

    {
        "meta": { "command": "...", "generated_at": "..." },
        "summary": "2-3 sentence summary",
        ... structured data ...
    }

Each function returns a plain dict ready for json.dumps().
"""

from __future__ import annotations

import datetime as dt
from typing import Any


def _now_iso() -> str:
    return dt.datetime.now(tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def json_meta(command: str, **kwargs: Any) -> dict[str, Any]:
    """Return the common meta block used by every --json response.

    Args:
        command: The CLI subcommand that produced this output.
        **kwargs: Additional meta fields (e.g. job_id, task, job_a, job_b).

    Returns:
        A dict with at minimum ``command`` and ``generated_at``.
    """
    meta: dict[str, Any] = {
        "command": command,
        "generated_at": _now_iso(),
    }
    meta.update(kwargs)
    return meta


def json_run_response(
    job_id: str,
    job_path: str,
    started_at: str,
    finished_at: str,
    status: str,
    binary: dict[str, Any],
    configuration: dict[str, Any],
    outcome: dict[str, Any],
    errors_by_type: dict[str, int],
) -> dict[str, Any]:
    """JSON response for ``tbench run --json``.

    Args:
        job_id: Harbor job identifier (e.g. ``2026-05-20__09-15-33``).
        job_path: Absolute path to the job directory.
        started_at: ISO-8601 timestamp when the run began.
        finished_at: ISO-8601 timestamp when the run ended.
        status: Final job status (e.g. ``complete``, ``failed``).
        binary: Dict with ``sha256``, ``path``, ``built_at``.
        configuration: Dict with ``environment``, ``concurrency``, ``trials``, ``task_filter``.
        outcome: Dict with ``total``, ``passed``, ``failed``, ``errors``, ``mean_reward``, ``runtime_sec``.
        errors_by_type: Mapping from error class name to occurrence count.

    Returns:
        Dict ready for ``json.dumps()``.
    """
    summary = (
        f"Completed {outcome['total']} tasks. "
        f"{outcome['passed']} passed ({outcome['mean_reward']:.1%}), "
        f"{outcome['failed']} failed, {outcome['errors']} error(s)."
    )
    if errors_by_type:
        summary += " " + " ".join(
            f"{count} {name}." for name, count in errors_by_type.items()
        )
    return {
        "meta": json_meta("run", job_id=job_id, job_path=job_path, started_at=started_at, finished_at=finished_at, status=status),
        "summary": summary,
        "binary": binary,
        "configuration": configuration,
        "outcome": outcome,
        "errors_by_type": errors_by_type,
    }


def json_show_response(
    job_id: str,
    overview: dict[str, Any],
    by_category: list[dict[str, Any]],
    errors: list[dict[str, Any]],
    comparison_with_previous: dict[str, Any] | None,
    all_tasks: list[dict[str, Any]],
) -> dict[str, Any]:
    """JSON response for ``tbench show --json``.

    Args:
        job_id: Harbor job identifier.
        overview: Dict with ``total``, ``passed``, ``failed``, ``errors``, ``mean_reward``, ``runtime_sec``, ``environment``, ``binary_sha256``.
        by_category: List of dicts with ``category``, ``total``, ``passed``, ``mean``.
        errors: List of dicts with ``task``, ``error_type``, ``duration_sec``, ``verifier_output_snippet``.
        comparison_with_previous: Dict with ``previous_job_id``, ``previous_mean``, ``mean_delta``, ``regressions``, ``improvements``, ``unchanged``.  May be ``None``.
        all_tasks: List of dicts with ``task``, ``reward``, ``status``.

    Returns:
        Dict ready for ``json.dumps()``.
    """
    summary = (
        f"Job {job_id}: {overview['passed']}/{overview['total']} passed "
        f"({overview['mean_reward']:.1%}). "
    )
    if overview["errors"]:
        summary += f"{overview['errors']} error(s). "
    if comparison_with_previous:
        delta = comparison_with_previous["mean_delta"]
        direction = "improved" if delta > 0 else "regressed" if delta < 0 else "unchanged"
        summary += (
            f"Mean reward {direction} by {abs(delta):.3f} vs previous run "
            f"{comparison_with_previous['previous_job_id']}."
        )
        if comparison_with_previous["regressions"]:
            summary += (
                f" Regressions: {', '.join(comparison_with_previous['regressions'])}."
            )
        if comparison_with_previous["improvements"]:
            summary += (
                f" Improvements: {', '.join(comparison_with_previous['improvements'])}."
            )
    else:
        summary += "No previous run available for comparison."

    return {
        "meta": json_meta("show", job_id=job_id),
        "summary": summary,
        "overview": overview,
        "by_category": by_category,
        "errors": errors,
        "comparison_with_previous": comparison_with_previous,
        "all_tasks": all_tasks,
    }


def json_inspect_response(
    job_id: str,
    task: str,
    trajectory_summary: dict[str, Any],
    tool_usage: dict[str, int],
    timeline: list[dict[str, Any]],
    verifier_result: dict[str, Any],
    full_atif_path: str,
) -> dict[str, Any]:
    """JSON response for ``tbench inspect --json``.

    Args:
        job_id: Harbor job identifier.
        task: Task name (e.g. ``configure-git``).
        trajectory_summary: Dict with ``total_steps``, ``agent_steps``, ``tool_calls``, ``error_steps``, ``final_step_before_timeout``, ``cost_usd``, ``prompt_tokens``, ``completion_tokens``.
        tool_usage: Mapping from tool name to call count.
        timeline: Condensed narrative step list (see design doc for shape).
        verifier_result: Dict with ``reward``, ``stdout``, ``stderr``.
        full_atif_path: Absolute path to the raw ``trajectory.json`` file.

    Returns:
        Dict ready for ``json.dumps()``.
    """
    error_count = len(trajectory_summary.get("error_steps", []))
    summary = (
        f"Task {task} in job {job_id}: {trajectory_summary['total_steps']} steps, "
        f"{trajectory_summary['tool_calls']} tool call(s)."
    )
    if error_count:
        summary += f" {error_count} error step(s)."
    summary += (
        f" Reward={verifier_result.get('reward', 'N/A')}."
    )
    return {
        "meta": json_meta("inspect", job_id=job_id, task=task),
        "summary": summary,
        "trajectory_summary": trajectory_summary,
        "tool_usage": tool_usage,
        "timeline": timeline,
        "verifier_result": verifier_result,
        "full_atif_path": full_atif_path,
    }


def json_diff_response(
    job_a: str,
    job_b: str,
    overview: dict[str, Any],
    task_changes: list[dict[str, Any]],
    unchanged: int,
    by_category_delta: list[dict[str, Any]],
    error_pattern_changes: dict[str, dict[str, int]],
) -> dict[str, Any]:
    """JSON response for ``tbench diff --json``.

    Args:
        job_a: First job identifier.
        job_b: Second job identifier.
        overview: Dict with ``mean_a``, ``mean_b``, ``mean_delta``, ``passed_a``, ``passed_b``, ``failed_a``, ``failed_b``, ``errors_a``, ``errors_b``.
        task_changes: List of dicts with ``task``, ``reward_a``, ``reward_b``, ``change`` (``fixed`` / ``regressed`` / ``changed``).
        unchanged: Number of tasks with identical results.
        by_category_delta: List of dicts with ``category``, ``mean_a``, ``mean_b``, ``delta``.
        error_pattern_changes: Mapping ``error_type -> {a: count, b: count}``.

    Returns:
        Dict ready for ``json.dumps()``.
    """
    fixed = [t for t in task_changes if t["change"] == "fixed"]
    regressed = [t for t in task_changes if t["change"] == "regressed"]
    summary = (
        f"Comparing {job_a} → {job_b}: mean reward {overview['mean_a']:.3f} → "
        f"{overview['mean_b']:.3f} ({overview['mean_delta']:+.3f}). "
    )
    summary += f"{len(fixed)} fixed, {len(regressed)} regressed, {unchanged} unchanged."
    if regressed:
        summary += (
            f" Regressions: {', '.join(t['task'] for t in regressed)}."
        )
    if fixed:
        summary += (
            f" Fixed: {', '.join(t['task'] for t in fixed)}."
        )
    return {
        "meta": json_meta("diff", job_a=job_a, job_b=job_b),
        "summary": summary,
        "overview": overview,
        "task_changes": task_changes,
        "unchanged": unchanged,
        "by_category_delta": by_category_delta,
        "error_pattern_changes": error_pattern_changes,
    }


def json_jobs_response(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    """JSON response for ``tbench jobs --json``.

    Args:
        jobs: List of job dicts, each with at minimum ``job_id``, ``date``, ``tasks``, ``passed``, ``failed``, ``errors``, ``mean_reward``, ``runtime_sec``, ``status``.

    Returns:
        Dict ready for ``json.dumps()``.
    """
    total_jobs = len(jobs)
    latest = jobs[0] if jobs else None
    summary = f"{total_jobs} job(s) found."
    if latest:
        summary += (
            f" Latest: {latest['job_id']} — {latest.get('passed', 0)}/{latest.get('tasks', 0)} passed"
            f" ({latest.get('mean_reward', 0):.1%})."
        )
    return {
        "meta": json_meta("ls"),
        "summary": summary,
        "jobs": jobs,
    }


def json_submit_response(
    job_id: str,
    valid: bool,
    checks: dict[str, Any],
    warnings: list[dict[str, Any]],
    errors: list[dict[str, Any]],
) -> dict[str, Any]:
    """JSON response for ``tbench submit --validate --json``.

    Args:
        job_id: Harbor job identifier being validated / packaged.
        valid: Whether the submission passes all hard checks.
        checks: Dict of named check results (e.g. ``timeout_multiplier``, ``coverage``).  Each value is a dict with at least ``passed: bool``.
        warnings: List of warning dicts with ``code``, ``severity``, ``message``, ``affected_tasks``.
        errors: List of error dicts with ``code``, ``severity``, ``message``, ``affected_tasks``.

    Returns:
        Dict ready for ``json.dumps()``.
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
