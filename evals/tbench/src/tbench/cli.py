"""tbench CLI — Cyclopts-based command interface."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from cyclopts import App, Parameter

from tbench import __version__
from tbench.config import load_config
from tbench.scanner import (
    TBenchScanner,
    discover_tasks,
    get_trial_directories,
)
from tbench.renderer import (
    render_job_table,
    render_job_detail,
    render_task_table,
    render_inspection,
    render_diff,
    render_submission_validation,
)
from tbench.json_formatter import (
    json_jobs_response,
    json_show_response,
    json_inspect_response,
    json_diff_response,
    json_submit_response,
)

app = App(
    name="tbench",
    version=__version__,
    help="Run Magnitude against Terminal Bench 2.1.",
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_json_mode() -> bool:
    """Return True if TBENCH_JSON env var is set."""
    return bool(os.environ.get("TBENCH_JSON"))


def _print_json(data: dict) -> None:
    """Print a dict as indented JSON and flush."""
    print(json.dumps(data, indent=2))


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


@app.command
def run(
    env: str = "local",
    concurrency: int = 4,
    trials: int = 1,
    difficulty: str | None = None,
    tasks: str | None = None,
    resume: str | None = None,
    detach: bool = False,
) -> None:
    """Start a benchmark run.

    Parameters
    ----------
    env: Environment to use ("local" or "modal").
    concurrency: Number of concurrent trials.
    trials: Number of trials per task.
    difficulty: Filter tasks by difficulty (easy/medium/hard).
    tasks: Comma-separated task names.
    resume: Resume a partial job (job dir name).
    detach: Start and detach (don't follow progress).
    """
    from tbench.run_orchestrator import run_benchmark
    import asyncio
    asyncio.run(run_benchmark(
        env=env,
        concurrency=concurrency,
        trials=trials,
        difficulty=difficulty,
        tasks=tasks,
        resume=resume,
        detach=detach,
    ))


@app.command
def jobs(
    limit: int = 20,
    since: str | None = None,
) -> None:
    """List benchmark jobs.

    Parameters
    ----------
    limit: Max jobs to list.
    since: Only jobs since date (YYYY-MM-DD).
    """
    scanner = TBenchScanner()
    job_names = scanner.list_jobs()

    # Filter by 'since' date
    if since:
        job_names = [j for j in job_names if j[:10] >= since]

    job_names = job_names[:limit]

    jobs: list[dict] = []
    for name in job_names:
        result = scanner.get_job_result(name)
        job_dict: dict = {
            "job_id": name,
            "date": name[:10] if len(name) >= 10 else name,
            "tasks": 0,
            "pass": 0,
            "fail": 0,
            "err": 0,
            "mean": 0.0,
            "runtime": "?",
            "status": "partial",
        }
        if result:
            job_dict["tasks"] = result.n_total_trials
            job_dict["status"] = "complete" if result.finished_at else "running"
            # Compute pass/fail/err from scanner's trial results
            for tn in scanner.list_trials(name):
                tr = scanner.get_trial_result(name, tn)
                if tr and tr.exception_info:
                    job_dict["err"] += 1
                elif tr and tr.verifier_result and tr.verifier_result.rewards:
                    reward = tr.verifier_result.rewards.get("reward", 0.0)
                    if float(reward) >= 1.0:
                        job_dict["pass"] += 1
                    else:
                        job_dict["fail"] += 1
                else:
                    job_dict["fail"] += 1
            # Mean reward from evals metrics
            for _eval_name, eval_stats in result.stats.evals.items():
                for m in eval_stats.metrics:
                    if isinstance(m, dict) and "mean" in m:
                        job_dict["mean"] = round(m["mean"], 3)
            if result.finished_at and result.started_at:
                delta = (result.finished_at - result.started_at).total_seconds()
                mins, secs = divmod(int(delta), 60)
                job_dict["runtime"] = f"{mins}m {secs}s"
        jobs.append(job_dict)

    if _is_json_mode():
        _print_json(json_jobs_response(jobs))
        return

    render_job_table(jobs)


@app.command
def show(
    job_id: str | None = None,
) -> None:
    """Show results for a job (default: latest).

    Parameters
    ----------
    job_id: Job directory name. Defaults to latest completed job.
    """
    scanner = TBenchScanner()
    target_job = job_id or scanner.find_latest_completed_job()
    if not target_job:
        print("No jobs found.")
        return

    result = scanner.get_job_result(target_job)
    cfg = scanner.get_job_config(target_job)

    # Build overview from Harbor's actual data structures
    total = passed = failed = errors = 0
    mean_reward = 0.0
    runtime_sec = 0
    environment = "?"
    binary_sha256 = None

    if result:
        total = result.n_total_trials
        # Compute pass/fail/err from scanner's trial results
        for tn in scanner.list_trials(target_job):
            tr = scanner.get_trial_result(target_job, tn)
            if tr and tr.exception_info:
                errors += 1
            elif tr and tr.verifier_result and tr.verifier_result.rewards:
                reward = tr.verifier_result.rewards.get("reward", 0.0)
                if float(reward) >= 1.0:
                    passed += 1
                else:
                    failed += 1
            else:
                failed += 1
        # Mean reward from evals metrics
        for _eval_name, eval_stats in result.stats.evals.items():
            for m in eval_stats.metrics:
                if isinstance(m, dict) and "mean" in m:
                    mean_reward = m["mean"]
        # Runtime
        if result.started_at and result.finished_at:
            runtime_sec = (result.finished_at - result.started_at).total_seconds()

    if cfg:
        env_cfg = getattr(cfg, "environment", None)
        if env_cfg:
            environment = getattr(env_cfg, "type", "?") or "?"
        binary_sha256 = scanner.get_binary_sha_from_config(target_job)

    # Error list from exception_stats
    errors_list: list[dict] = []
    if result:
        for eval_name, eval_stats in result.stats.evals.items():
            for ex_type, trial_names in eval_stats.exception_stats.items():
                for tn in trial_names:
                    task_part = tn.split("__")[0] if "__" in tn else tn
                    errors_list.append({
                        "task": task_part,
                        "error_type": ex_type,
                        "duration_sec": 0,
                    })

    # Per-task breakdown from trial results
    all_tasks: list[dict] = []
    trial_names = scanner.list_trials(target_job)
    for tn in trial_names:
        tr = scanner.get_trial_result(target_job, tn)
        task_part = tn.split("__")[0] if "__" in tn else tn
        if tr:
            reward = 0.0
            if tr.verifier_result and hasattr(tr.verifier_result, "rewards"):
                reward = tr.verifier_result.rewards.get("reward", 0.0)
            status = "passed" if reward >= 1.0 else "failed"
            if tr.exception_info:
                status = "error"
            all_tasks.append({"task": task_part, "reward": reward, "status": status})

    # Comparison with previous same-binary job
    comparison = None
    prev_job = scanner.find_job_with_same_binary(target_job)
    if prev_job:
        prev_result = scanner.get_job_result(prev_job)
        if prev_result:
            prev_mean = 0.0
            for eval_name, eval_stats in prev_result.stats.evals.items():
                for m in eval_stats.metrics:
                    if isinstance(m, dict) and "mean" in m:
                        prev_mean = m["mean"]
            # Find regressions and improvements
            prev_tasks = {}
            for tn in scanner.list_trials(prev_job):
                tr = scanner.get_trial_result(prev_job, tn)
                task_part = tn.split("__")[0] if "__" in tn else tn
                if tr and tr.verifier_result and hasattr(tr.verifier_result, "rewards"):
                    prev_tasks[task_part] = tr.verifier_result.rewards.get("reward", 0.0)
            cur_tasks = {t["task"]: t["reward"] for t in all_tasks}
            regressions = []
            improvements = []
            for task, cur_reward in cur_tasks.items():
                prev_reward = prev_tasks.get(task)
                if prev_reward is not None and prev_reward != cur_reward:
                    if cur_reward < prev_reward:
                        regressions.append(task)
                    else:
                        improvements.append(task)
            comparison = {
                "previous_job_id": prev_job,
                "previous_mean": prev_mean,
                "mean_delta": mean_reward - prev_mean,
                "regressions": regressions,
                "improvements": improvements,
                "unchanged": len(cur_tasks) - len(regressions) - len(improvements),
            }

    job = {
        "job_id": target_job,
        "environment": environment,
        "workers": getattr(cfg, "n_concurrent_trials", "?") if cfg else "?",
        "total": total,
        "passed": passed,
        "failed": failed,
        "errors": errors,
        "mean_reward": mean_reward,
        "runtime_sec": runtime_sec,
        "binary_sha256": binary_sha256,
        "categories": [],
        "errors_list": errors_list,
        "improvements": comparison.get("improvements", []) if comparison else [],
        "regressions": comparison.get("regressions", []) if comparison else [],
    }

    if _is_json_mode():
        _print_json(json_show_response(
            job_id=target_job,
            overview={
                "total": total,
                "passed": passed,
                "failed": failed,
                "errors": errors,
                "mean_reward": mean_reward,
                "runtime_sec": runtime_sec,
                "environment": environment,
                "binary_sha256": binary_sha256,
            },
            by_category=[],
            errors=errors_list,
            comparison_with_previous=comparison,
            all_tasks=all_tasks,
        ))
        return

    render_job_detail(job, comparison)


@app.command
def inspect(
    job_id: str,
    task_name: str,
    steps: int | None = None,
    step: int | None = None,
    tools: bool = False,
    errors_only: bool = False,
) -> None:
    """Investigate a task failure (ATIF timeline).

    Parameters
    ----------
    job_id: Job directory name.
    task_name: Task to inspect.
    steps: Show last N steps (negative = last N).
    step: Show one specific step in full detail.
    tools: Show tool usage summary only.
    errors_only: Show only error steps and surrounding context.
    """
    from tbench.atif import load_trajectory, summarize_trajectory, build_timeline, extract_tool_usage

    scanner = TBenchScanner()
    job_dir = scanner.get_job_dir(job_id)
    trial_dirs = scanner.get_trial_dirs(job_id)

    # Find the trial directory matching task_name
    target_trial_dir: Path | None = None
    for td in trial_dirs:
        parsed = scanner.parse_trial_dir_name(td.name)
        if parsed.get("task_name") == task_name:
            target_trial_dir = td
            break

    if target_trial_dir is None:
        print(f"Task '{task_name}' not found in job '{job_id}'.")
        return

    traj_path = target_trial_dir / "agent" / "trajectory.json"
    if not traj_path.exists():
        print(f"No trajectory.json found for task '{task_name}'.")
        return

    traj = load_trajectory(traj_path)
    summary = summarize_trajectory(traj)
    timeline = build_timeline(traj, errors_only=errors_only)
    tool_usage = extract_tool_usage(traj)

    # Verifier result from Harbor's TrialResult
    trial_result = scanner.get_trial_result(job_id, target_trial_dir.name)
    verifier_result: dict = {}
    reward = 0.0
    if trial_result:
        if trial_result.verifier_result and trial_result.verifier_result.rewards:
            reward = trial_result.verifier_result.rewards.get("reward", 0.0)
        verifier_result = {"reward": reward}

    # Status
    if trial_result and trial_result.exception_info:
        status = "error"
    elif reward >= 1.0:
        status = "passed"
    else:
        status = "failed"

    if _is_json_mode():
        timeline_dicts = [t.model_dump() for t in timeline]
        _print_json(json_inspect_response(
            job_id=job_id,
            task=task_name,
            trajectory_summary=summary.model_dump(),
            tool_usage=tool_usage,
            timeline=timeline_dicts,
            verifier_result=verifier_result,
            full_atif_path=str(traj_path.resolve()),
        ))
        return

    if tools:
        # Human: just print tool usage
        for name, count in tool_usage.items():
            print(f"  {name}: {count}")
        return

    inspection = {
        "task": task_name,
        "job_id": job_id,
        "status": status,
        "reward": reward,
        "duration_sec": 0,
        "timeout_sec": 0,
        "steps": summary.total_steps,
        "cost_usd": summary.cost_usd or 0.0,
        "timeline": [t.model_dump() for t in timeline],
        "verifier_result": verifier_result,
        "tool_usage": tool_usage,
    }
    render_inspection(inspection)


@app.command
def diff(
    job_a: str | None = None,
    job_b: str | None = None,
    task: str | None = None,
) -> None:
    """Compare two runs (default: last two same-binary jobs).

    Parameters
    ----------
    job_a: First job directory name.
    job_b: Second job directory name.
    task: Compare only a specific task.
    """
    scanner = TBenchScanner()

    if job_a is None:
        job_a = scanner.find_latest_completed_job()
    if job_b is None and job_a:
        job_b = scanner.find_job_with_same_binary(job_a)

    if not job_a or not job_b:
        print("Could not find two jobs to compare.")
        return

    result_a = scanner.get_job_result(job_a)
    result_b = scanner.get_job_result(job_b)

    def _job_stats(job_name):
        """Extract stats for a job using scanner's trial-level API."""
        result = scanner.get_job_result(job_name)
        total = passed = failed = errors = 0
        mean = 0.0
        if result:
            total = result.n_total_trials
            for tn in scanner.list_trials(job_name):
                tr = scanner.get_trial_result(job_name, tn)
                if tr and tr.exception_info:
                    errors += 1
                elif tr and tr.verifier_result and tr.verifier_result.rewards:
                    reward = tr.verifier_result.rewards.get("reward", 0.0)
                    if float(reward) >= 1.0:
                        passed += 1
                    else:
                        failed += 1
                else:
                    failed += 1
            for _eval_name, eval_stats in result.stats.evals.items():
                for m in eval_stats.metrics:
                    if isinstance(m, dict) and "mean" in m:
                        mean = m["mean"]
        return total, passed, failed, errors, mean

    total_a, passed_a, failed_a, errors_a, mean_a = _job_stats(job_a)
    total_b, passed_b, failed_b, errors_b, mean_b = _job_stats(job_b)

    # Build per-task reward maps from scanner (keyed by base task name, e.g. "fix-git")
    # Takes max reward across multiple trials for same task (n_attempts > 1)
    def _task_rewards(job_name):
        rewards: dict[str, float] = {}
        for tn in scanner.list_trials(job_name):
            tr = scanner.get_trial_result(job_name, tn)
            reward = 0.0
            if tr and tr.verifier_result and tr.verifier_result.rewards:
                reward = tr.verifier_result.rewards.get("reward", 0.0)
            base_name = tn.split("__")[0] if "__" in tn else tn
            rewards[base_name] = max(rewards.get(base_name, 0.0), reward)
        return rewards

    tasks_a = _task_rewards(job_a)
    tasks_b = _task_rewards(job_b)

    # Task-level changes
    task_changes: list[dict] = []
    all_task_names = sorted(set(tasks_a.keys()) | set(tasks_b.keys()))
    unchanged = 0
    for t_name in all_task_names:
        if task and t_name != task:
            continue
        r_a = tasks_a.get(t_name)
        r_b = tasks_b.get(t_name)
        if r_a is None or r_b is None:
            continue
        if r_a != r_b:
            if r_a >= 1.0 and r_b < 1.0:
                change = "regressed"
            elif r_a < 1.0 and r_b >= 1.0:
                change = "fixed"
            else:
                change = "changed"
            task_changes.append({
                "task": t_name,
                "reward_a": r_a,
                "reward_b": r_b,
                "change": change,
            })
        else:
            unchanged += 1

    if _is_json_mode():
        _print_json(json_diff_response(
            job_a=job_a,
            job_b=job_b,
            overview={
                "mean_a": mean_a,
                "mean_b": mean_b,
                "mean_delta": mean_b - mean_a,
                "passed_a": passed_a,
                "passed_b": passed_b,
                "failed_a": failed_a,
                "failed_b": failed_b,
                "errors_a": errors_a,
                "errors_b": errors_b,
                "total_a": total_a,
                "total_b": total_b,
            },
            task_changes=task_changes,
            unchanged=unchanged,
            by_category_delta=[],
            error_pattern_changes={},
        ))
        return

    diff_data = {
        "job_a": job_a,
        "job_b": job_b,
        "mean_a": mean_a,
        "mean_b": mean_b,
        "mean_delta": mean_b - mean_a,
        "passed_a": passed_a,
        "passed_b": passed_b,
        "failed_a": failed_a,
        "failed_b": failed_b,
        "errors_a": errors_a,
        "errors_b": errors_b,
        "total_a": total_a,
        "total_b": total_b,
        "task_changes": task_changes,
        "by_category_delta": [],
        "error_pattern_changes": {},
    }
    render_diff(diff_data)


@app.command
def logs(
    job_id: str,
    task_name: str | None = None,
    follow: bool = False,
    stream: str = "stdout",
) -> None:
    """Stream or replay agent logs.

    Parameters
    ----------
    job_id: Job directory name.
    task_name: Specific task to show logs for.
    follow: Tail a running job.
    stream: Log stream to show (stdout or stderr).
    """
    scanner = TBenchScanner()
    job_dir = scanner.get_job_dir(job_id)

    if task_name:
        trial_dirs = scanner.get_trial_dirs(job_id)
        target_trial_dir: Path | None = None
        for td in trial_dirs:
            parsed = scanner.parse_trial_dir_name(td.name)
            if parsed.get("task_name") == task_name:
                target_trial_dir = td
                break
        if target_trial_dir is None:
            print(f"Task '{task_name}' not found in job '{job_id}'.")
            return
        log_path = target_trial_dir / "agent" / "magnitude.txt"
        if not log_path.exists():
            print(f"No log found at {log_path}")
            return
        if follow:
            subprocess.run(["tail", "-f", str(log_path)])
        else:
            print(log_path.read_text())
    else:
        # Job-level logs: print all trial agent logs in order
        trial_dirs = scanner.get_trial_dirs(job_id)
        for td in trial_dirs:
            log_path = td / "agent" / "magnitude.txt"
            if log_path.exists():
                print(f"--- {td.name} ---")
                print(log_path.read_text())
                print()


@app.command
def build(
    check: bool = False,
    force: bool = False,
) -> None:
    """Build or check the Linux binary.

    Parameters
    ----------
    check: Check if binary is stale without building.
    force: Rebuild even if not stale.
    """
    from tbench.binary import build, is_stale
    if check:
        stale = is_stale()
        if stale:
            print("Binary is stale — source has changed since last build.")
        else:
            print("Binary is up to date.")
    else:
        path = build(force=force)
        print(f"Built: {path}")


@app.command
def seed(
    force: bool = False,
) -> None:
    """Seed Modal volume with the current binary.

    Parameters
    ----------
    force: Re-upload even if hash matches.
    """
    from tbench.binary import seed_modal_volume
    seed_modal_volume(force=force)


@app.command
def view(
    job_id: str | None = None,
    task_name: str | None = None,
) -> None:
    """Open Harbor web trajectory viewer.

    Parameters
    ----------
    job_id: Job directory name.
    task_name: Specific task to focus on.
    """
    scanner = TBenchScanner()
    target = job_id or scanner.find_latest_completed_job()
    if not target:
        print("No jobs found.")
        return
    job_dir = scanner.get_job_dir(target)
    print(f"Job directory: {job_dir}")
    print(f"To view: harbor view {job_dir} --web")


@app.command
def submit(
    validate: bool = False,
    package: bool = False,
    output: str | None = None,
    *jobs: str,
) -> None:
    """Validate and package for leaderboard submission.

    Parameters
    ----------
    validate: Validate jobs for submission.
    package: Package jobs for submission.
    output: Output directory for packaging.
    jobs: Job directory names to validate/package.
    """
    from tbench.submit import validate_submission, package_submission

    if not jobs:
        print("No jobs specified.")
        return

    scanner = TBenchScanner()

    if validate:
        result = validate_submission(scanner, list(jobs))
        checks: dict[str, Any] = {}
        warnings = [w.model_dump() for w in result.warnings]
        errors = [e.model_dump() for e in result.errors]

        if _is_json_mode():
            _print_json(json_submit_response(
                job_id=jobs[0],
                valid=result.valid,
                checks=checks,
                warnings=warnings,
                errors=errors,
            ))
            return

        validation = {
            "valid": result.valid,
            "checks": checks,
            "warnings": warnings,
            "errors": errors,
        }
        render_submission_validation(validation)
        return

    if package:
        if not output:
            print("--output is required for packaging.")
            return
        out_path = package_submission(scanner, list(jobs), Path(output))
        print(f"Packaged to: {out_path}")
        return

    print("Use --validate or --package.")


@app.command
def tasks(
    task_name: str | None = None,
    open_link: bool = False,
    category: str | None = None,
    difficulty: str | None = None,
    list_all: bool = False,
) -> None:
    """Show task details or list available tasks.

    Parameters
    ----------
    task_name: Task name to inspect.
    open_link: Open the task page on tbench.ai in your browser.
    category: Filter by category (with --list-all or no task_name).
    difficulty: Filter by difficulty (with --list-all or no task_name).
    list_all: List all available tasks.
    """
    if not task_name and not list_all:
        list_all = True

    if list_all:
        raw_tasks = discover_tasks(difficulty=difficulty, category=category)
        if _is_json_mode():
            _print_json({"meta": {"command": "tasks"}, "tasks": raw_tasks})
            return
        from rich.console import Console
        from rich.table import Table
        console = Console()
        table = Table(title="Terminal Bench Tasks", show_lines=False, pad_edge=False)
        table.add_column("Task", style="bold", max_width=30)
        table.add_column("Diff", width=6)
        table.add_column("Category", max_width=20)
        table.add_column("Expert", width=7)
        table.add_column("Tags", max_width=25)
        table.add_column("Description", max_width=60)
        for t in raw_tasks:
            diff = t.get("difficulty") or "?"
            diff_style = {"easy": "green", "medium": "yellow", "hard": "red"}.get(diff, "")
            expert = int(t.get("expert_time_estimate_min") or 0)
            expert_str = f"~{expert}m" if expert else "—"
            tags = ", ".join(t.get("tags", [])[:4])
            desc = (t.get("description") or "")[:100]
            table.add_row(
                t["name"],
                f"[{diff_style}]{diff}[/{diff_style}]" if diff_style else diff,
                t.get("category") or "—",
                expert_str,
                tags,
                desc,
            )
        console.print(table)
        return

    # Show single task detail
    tasks = discover_tasks()
    target = None
    for t in tasks:
        if t["name"] == task_name:
            target = t
            break

    if not target:
        print(f"Task '{task_name}' not found. Use 'tbench tasks --list-all' to see available tasks.")
        return

    if _is_json_mode():
        _print_json(target)
        return

    from rich.console import Console
    from rich.panel import Panel
    from rich.text import Text
    console = Console()

    diff = target.get("difficulty") or "?"
    diff_style = {"easy": "green", "medium": "yellow", "hard": "red"}.get(diff, "")
    expert = int(target.get("expert_time_estimate_min") or 0)
    timeout = int(target.get("timeout_sec") or 0)
    author = target.get("author") or "—"
    tags = ", ".join(target.get("tags", []))
    category = target.get("category") or "—"
    url = f"https://www.tbench.ai/benchmarks/terminal-bench-2/{task_name}"

    header = f"[bold]{task_name}[/]\n"
    header += f"  Difficulty: [{diff_style}]{diff}[/{diff_style}]  │  Category: {category}  │  Expert: ~{expert}m  │  Timeout: {timeout}s\n"
    header += f"  Author: {author}  │  Tags: {tags}\n"
    header += f"  Link: {url}"
    console.print(Panel(header, title="Task", border_style="blue"))

    instruction = target.get("instruction") or ""
    if instruction:
        console.print(Panel(instruction, title="Instruction", border_style="dim"))

    if open_link:
        import webbrowser
        webbrowser.open(url)
        print(f"Opened {url}")


@app.command
def config(
    edit: bool = False,
    show_path: bool = False,
) -> None:
    """Show or edit configuration.

    Parameters
    ----------
    edit: Open .tbench.toml in $EDITOR.
    show_path: Show config file path.
    """
    from tbench.config import _find_config_files
    if show_path:
        files = _find_config_files()
        if files:
            for f in files:
                print(f)
        else:
            print("No .tbench.toml found (using defaults)")
    elif edit:
        target = Path.cwd() / ".tbench.toml"
        if not target.exists():
            print(f"No .tbench.toml at {target}")
            return
        editor = os.environ.get("EDITOR", "vim")
        subprocess.run([editor, str(target)])
    else:
        cfg = load_config()
        print(cfg.model_dump_json(indent=2))




def main() -> None:
    app()
