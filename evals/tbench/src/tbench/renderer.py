"""Human output formatting using Rich.

Provides render_* functions for every CLI command that prints to stdout.
All functions are pure side-effect (print) — they receive dicts/lists and
use Rich Console/Table/Panel/Progress to produce color-coded human output.

Color convention:
  green  = pass / fixed / ready
  red    = fail / regressed / error
  yellow = error / warning / timeout
  cyan   = running / active
  magenta = improvement / new
"""

from __future__ import annotations

from typing import Any

from rich.align import Align
from rich.bar import Bar
from rich.console import Console, Group
from rich.layout import Layout
from rich.panel import Panel
from rich.progress import BarColumn, Progress, TextColumn, TimeRemainingColumn
from rich.table import Table
from rich.text import Text

# Global console used by all renderers.
_CONSOLE: Console | None = None


def get_console() -> Console:
    """Return the global Console, creating it on first call."""
    global _CONSOLE  # noqa: PLW0603
    if _CONSOLE is None:
        _CONSOLE = Console()
    return _CONSOLE


def _centered(text: str, style: str = "") -> Align:
    return Align.center(Text(text, style=style))


def _bold(text: str) -> Text:
    return Text(text, style="bold")


def _make_progress_bar(passed: int, failed: int, errors: int, total: int) -> Bar:
    """Return a Rich Bar for pass/fail/error proportions."""
    if total == 0:
        return Bar(0, 0, 0, 0)
    return Bar(
        size=total,
        begin=passed,
        end=passed + failed,
        width=total,
        color="green",
        bgcolor="red",
    )


def render_job_table(jobs: list[dict]) -> None:
    """Print a compact table of jobs.

    Expected job dict keys:
        job_id, date, tasks, pass, fail, err, mean, runtime, status
    """
    console = get_console()
    table = Table(title="Jobs")
    table.add_column("Job ID", style="cyan", no_wrap=True)
    table.add_column("Date", style="white")
    table.add_column("Tasks", justify="right", style="white")
    table.add_column("Pass", justify="right", style="green")
    table.add_column("Fail", justify="right", style="red")
    table.add_column("Err", justify="right", style="yellow")
    table.add_column("Mean", justify="right", style="white")
    table.add_column("Runtime", justify="right", style="white")
    table.add_column("Status", style="bold")

    for job in jobs:
        status = job.get("status", "unknown")
        status_style = {
            "complete": "green",
            "running": "cyan",
            "failed": "red",
            "cancelled": "yellow",
        }.get(status, "white")

        table.add_row(
            job.get("job_id", "—"),
            job.get("date", "—"),
            str(job.get("tasks", "—")),
            str(job.get("pass", "—")),
            str(job.get("fail", "—")),
            str(job.get("err", "—")),
            str(job.get("mean", "—")),
            str(job.get("runtime", "—")),
            Text(status, style=status_style),
        )

    console.print(table)


def render_job_detail(job: dict, comparison: dict | None = None) -> None:
    """Print a detailed job panel with optional comparison to a previous run.

    Expected job keys:
        job_id, environment, workers, total, passed, failed, errors,
        mean_reward, runtime_sec, binary_sha256, categories, errors_list,
        improvements, regressions
    Expected comparison keys (if provided):
        previous_job_id, previous_mean, mean_delta,
        regressions, improvements, unchanged
    """
    console = get_console()

    # Header
    header_text = (
        f"{job.get('job_id', '—')}    "
        f"{job.get('environment', '—')} · "
        f"{job.get('workers', '—')} workers"
    )
    header = Text(header_text, style="bold cyan")

    # Overview line
    total = job.get("total", 0)
    passed = job.get("passed", 0)
    failed = job.get("failed", 0)
    errors = job.get("errors", 0)
    mean = job.get("mean_reward", 0.0)
    runtime = job.get("runtime_sec", 0)
    runtime_str = f"{int(runtime // 60)}m {int(runtime % 60):02d}s"

    overview = Text.assemble(
        (f"  {passed} passed", "green"),
        (" │ ", "white"),
        (f"{failed} failed", "red"),
        (" │ ", "white"),
        (f"{errors} errors", "yellow"),
        (" │ ", "white"),
        (f"Mean: {mean:.3f}", "white"),
        (" │ ", "white"),
        (f"Runtime: {runtime_str}", "white"),
    )

    # Full-width progress bar as a mini-table row
    bar = Bar(
        size=total or 1,
        begin=passed,
        end=passed + failed,
        width=total or 1,
        color="green",
        bgcolor="red",
    )

    # Category breakdown
    category_rows: list[Text | str] = []
    for cat in job.get("categories", []):
        name = cat.get("category", "—")
        cat_total = cat.get("total", 0)
        cat_passed = cat.get("passed", 0)
        cat_mean = cat.get("mean", 0.0)
        cat_bar = "█" * int(cat_mean * 10) + "░" * (10 - int(cat_mean * 10))
        row = Text.assemble(
            (f"  {name:20}", "white"),
            (f" {cat_bar}  ", "white"),
            (f"{cat_passed}/{cat_total}  ({cat_mean:.0%})", "white"),
        )
        category_rows.append(row)

    category_panel = Panel(
        Group(*category_rows) if category_rows else Text("  No categories", style="dim"),
        title="Category Breakdown",
        border_style="blue",
    )

    # Errors list
    errors_rows: list[Text] = []
    for err in job.get("errors_list", []):
        task = err.get("task", "—")
        err_type = err.get("error_type", "—")
        duration = err.get("duration_sec", 0)
        duration_str = f"{int(duration // 60)}m {int(duration % 60):02d}s"
        errors_rows.append(
            Text.assemble(
                (f"  {task:20}", "white"),
                (f" {err_type:20}", "yellow"),
                (f" {duration_str}", "dim"),
            )
        )

    errors_panel = Panel(
        Group(*errors_rows) if errors_rows else Text("  No errors", style="dim"),
        title=f"Errors ({len(errors_rows)})",
        border_style="yellow",
    )

    # Comparison section
    panels: list[Any] = [header, overview, bar, category_panel, errors_panel]

    if comparison:
        prev_id = comparison.get("previous_job_id", "—")
        prev_mean = comparison.get("previous_mean", 0.0)
        delta = comparison.get("mean_delta", 0.0)
        delta_sign = "▲" if delta >= 0 else "▼"
        delta_style = "green" if delta >= 0 else "red"

        comp_header = Text.assemble(
            ("  Comparison with previous run ", "white"),
            (f"{prev_id}", "cyan"),
            (f"  {prev_mean:.3f} → {mean:.3f}  ", "white"),
            (f"{delta_sign} {abs(delta):+.3f}", delta_style),
        )
        panels.append(comp_header)

        # Regressions
        regressions = comparison.get("regressions", [])
        if regressions:
            reg_rows: list[Text] = []
            for r in regressions:
                reg_rows.append(
                    Text.assemble(
                        ("  ✗ ", "red"),
                        (f"{r}", "white"),
                        ("  regressed", "dim red"),
                    )
                )
            panels.append(Panel(
                Group(*reg_rows),
                title="Regressions",
                border_style="red",
            ))

        # Improvements
        improvements = comparison.get("improvements", [])
        if improvements:
            imp_rows: list[Text] = []
            for i in improvements:
                imp_rows.append(
                    Text.assemble(
                        ("  ✓ ", "green"),
                        (f"{i}", "white"),
                        ("  improved", "dim green"),
                    )
                )
            panels.append(Panel(
                Group(*imp_rows),
                title="Improvements",
                border_style="green",
            ))

    console.print(Panel(
        Group(*panels),
        border_style="bright_blue",
    ))


def render_task_table(tasks: list[dict]) -> None:
    """Print a table of tasks for a job.

    Expected task keys:
        task, category, reward, time, status
    """
    console = get_console()
    table = Table(title="Tasks")
    table.add_column("Task", style="cyan", no_wrap=True)
    table.add_column("Category", style="white")
    table.add_column("Reward", justify="right", style="white")
    table.add_column("Time", justify="right", style="white")
    table.add_column("Status", style="bold")

    for task in tasks:
        status = task.get("status", "unknown")
        status_style = {
            "passed": "green",
            "failed": "red",
            "error": "yellow",
            "running": "cyan",
            "available": "dim",
        }.get(status, "white")

        table.add_row(
            task.get("task", "—"),
            task.get("category", "—"),
            str(task.get("reward", "—")),
            str(task.get("time", "—")),
            Text(status, style=status_style),
        )

    console.print(table)


def render_category_bars(categories: list[dict]) -> None:
    """Print mini progress bars per category.

    Expected category keys:
        category, total, passed, mean
    """
    console = get_console()
    table = Table(show_header=False, box=None, pad_edge=False)
    table.add_column("Category", style="white")
    table.add_column("Bar", style="white")
    table.add_column("Score", justify="right", style="white")

    for cat in categories:
        name = cat.get("category", "—")
        total = cat.get("total", 0)
        passed = cat.get("passed", 0)
        mean = cat.get("mean", 0.0)

        bar = Bar(
            size=total or 1,
            begin=passed,
            end=passed,
            width=total or 1,
            color="green",
            bgcolor="bright_black",
        )

        table.add_row(
            name,
            bar,
            f"{passed}/{total}  ({mean:.0%})",
        )

    console.print(table)


def render_progress_bar(
    completed: int,
    total: int,
    passed: int,
    failed: int,
    errors: int,
) -> None:
    """Print a live progress bar for running jobs.

    This is meant to be called repeatedly (e.g. from a hook callback).
    Rich Progress handles in-place terminal updates automatically.
    """
    console = get_console()
    progress = Progress(
        TextColumn("[bold blue]Progress:"),
        BarColumn(bar_width=None),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TextColumn("•"),
        TextColumn("[green]{task.fields[passed]} passed"),
        TextColumn("[red]{task.fields[failed]} failed"),
        TextColumn("[yellow]{task.fields[errors]} errors"),
        TimeRemainingColumn(),
        console=console,
        transient=True,
    )
    task = progress.add_task(
        "",
        total=total,
        completed=completed,
        passed=passed,
        failed=failed,
        errors=errors,
    )
    progress.update(task, completed=completed)
    progress.refresh()


def render_inspection(inspection: dict) -> None:
    """Print a task inspector timeline view.

    Expected inspection keys:
        task, job_id, status, reward, duration_sec, timeout_sec,
        steps, cost_usd, timeline, verifier_result, tool_usage
    """
    console = get_console()

    task = inspection.get("task", "—")
    job_id = inspection.get("job_id", "—")
    status = inspection.get("status", "—")
    reward = inspection.get("reward", 0.0)
    duration = inspection.get("duration_sec", 0)
    timeout = inspection.get("timeout_sec", 0)
    steps = inspection.get("steps", 0)
    cost = inspection.get("cost_usd", 0.0)

    status_style = "green" if status == "passed" else "red" if status == "failed" else "yellow"
    header = Text.assemble(
        (f"{task}", "bold cyan"),
        ("  ·  ", "white"),
        (f"{job_id}", "dim"),
        ("  ·  ", "white"),
        (f"{status.upper()} ({reward})", status_style),
    )

    meta = Text.assemble(
        (f"  Duration: {int(duration // 60)}m {int(duration % 60):02d}s", "white"),
        (f"  ·  Agent timeout: {timeout}s", "white"),
        (f"  ·  Steps: {steps}", "white"),
        (f"  ·  Cost: ${cost:.4f}", "white"),
    )

    # Timeline
    timeline_rows: list[Text | Panel] = []
    for entry in inspection.get("timeline", []):
        step_num = entry.get("step", "?")
        source = entry.get("source", "?")
        summary = entry.get("summary", "—")
        error = entry.get("error")

        source_style = {
            "system": "dim",
            "agent": "cyan",
            "tool_call": "blue",
        }.get(source, "white")

        line = Text.assemble(
            (f"  {step_num:>3}  ", "dim"),
            (f"{source:10}", source_style),
            (" → ", "dim"),
            (f"{summary}", "white"),
        )

        if error:
            err_line = Text.assemble(
                ("      ❌ Error: ", "red"),
                (f"{error.get('message', str(error))}", "red"),
            )
            timeline_rows.append(Group(line, err_line))
        else:
            timeline_rows.append(line)

    timeline_panel = Panel(
        Group(*timeline_rows) if timeline_rows else Text("  No steps", style="dim"),
        title="Step Timeline",
        border_style="blue",
    )

    # Verifier result
    verifier = inspection.get("verifier_result", {})
    verifier_text = Text.assemble(
        (f"  Expected: {verifier.get('expected', '—')}", "white"),
        ("\n", ""),
        (f"  Actual:   {verifier.get('actual', '—')}", "white"),
    )
    verifier_panel = Panel(
        verifier_text,
        title="Verifier Output",
        border_style="magenta",
    )

    # Tool usage
    tools = inspection.get("tool_usage", {})
    tool_text = Text.assemble(
        *[
            (f"  • {name}: {count}  ", "white")
            for name, count in tools.items()
        ]
    ) if tools else Text("  No tool calls", style="dim")
    tool_panel = Panel(
        tool_text,
        title=f"Key Tool Calls ({sum(tools.values())} total)",
        border_style="blue",
    )

    console.print(Panel(
        Group(header, meta, Text(), timeline_panel, verifier_panel, tool_panel),
        border_style="bright_blue",
    ))


def render_diff(diff_data: dict) -> None:
    """Print a side-by-side comparison view of two runs.

    Expected diff_data keys:
        job_a, job_b, mean_a, mean_b, mean_delta,
        passed_a, passed_b, failed_a, failed_b, errors_a, errors_b,
        task_changes, by_category_delta, error_pattern_changes
    """
    console = get_console()

    job_a = diff_data.get("job_a", "—")
    job_b = diff_data.get("job_b", "—")
    mean_a = diff_data.get("mean_a", 0.0)
    mean_b = diff_data.get("mean_b", 0.0)
    delta = diff_data.get("mean_delta", 0.0)
    delta_sign = "▲" if delta >= 0 else "▼"
    delta_style = "green" if delta >= 0 else "red"

    header = Text.assemble(
        (f"{job_a}", "cyan"),
        ("  →  ", "white"),
        (f"{job_b}", "cyan"),
        ("\n", ""),
        (f"  {mean_a:.3f} ({diff_data.get('passed_a', 0)}/", "white"),
        (f"{diff_data.get('total_a', 0)})  →  ", "white"),
        (f"{mean_b:.3f} ({diff_data.get('passed_b', 0)}/", "white"),
        (f"{diff_data.get('total_b', 0)})", "white"),
        (f"    {delta_sign} {abs(delta):+.3f}", delta_style),
    )

    # Task changes table
    changes = diff_data.get("task_changes", [])
    if changes:
        change_rows: list[Text] = []
        for change in changes:
            task = change.get("task", "—")
            reward_a = change.get("reward_a", 0.0)
            reward_b = change.get("reward_b", 0.0)
            ctype = change.get("change", "—")

            if ctype == "fixed":
                glyph = "✓"
                glyph_style = "green"
                label = "FIXED"
                label_style = "dim green"
            elif ctype == "regressed":
                glyph = "✗"
                glyph_style = "red"
                label = "REGRESSED"
                label_style = "dim red"
            else:
                glyph = "~"
                glyph_style = "yellow"
                label = ctype.upper()
                label_style = "dim yellow"

            change_rows.append(Text.assemble(
                (f"  {glyph} ", glyph_style),
                (f"{task:20}", "white"),
                (f" {reward_a:.1f} → {reward_b:.1f}   ", "white"),
                (f"{label}", label_style),
            ))

        changes_panel = Panel(
            Group(*change_rows),
            title=f"Task Changes ({len(changes)} total)",
            border_style="blue",
        )
    else:
        changes_panel = Panel(
            Text("  No changes", style="dim"),
            title="Task Changes",
            border_style="blue",
        )

    # Category impact
    cat_deltas = diff_data.get("by_category_delta", [])
    if cat_deltas:
        cat_rows: list[Text] = []
        for cd in cat_deltas:
            cat = cd.get("category", "—")
            m_a = cd.get("mean_a", 0.0)
            m_b = cd.get("mean_b", 0.0)
            d = cd.get("delta", 0.0)
            d_sign = "▲" if d >= 0 else "▼"
            d_style = "green" if d >= 0 else "red"
            d_sign_prefix = "+" if d >= 0 else "-"
            cat_rows.append(Text.assemble(
                (f"  {cat:20}", "white"),
                (f" {m_a:.3f} → {m_b:.3f}  ", "white"),
                (f"{d_sign} {d_sign_prefix}{abs(d):.3f}", d_style),
            ))
        cat_panel = Panel(
            Group(*cat_rows),
            title="Category Impact",
            border_style="blue",
        )
    else:
        cat_panel = Panel(
            Text("  No category data", style="dim"),
            title="Category Impact",
            border_style="blue",
        )

    # Error patterns
    error_patterns = diff_data.get("error_pattern_changes", {})
    if error_patterns:
        ep_rows: list[Text] = []
        for err_type, counts in error_patterns.items():
            a_count = counts.get("a", 0)
            b_count = counts.get("b", 0)
            diff = b_count - a_count
            diff_sign = "+" if diff > 0 else ""
            diff_style = "red" if diff > 0 else "green" if diff < 0 else "white"
            ep_rows.append(Text.assemble(
                (f"  {err_type:20}", "white"),
                (f" {a_count} → {b_count}  ", "white"),
                (f"({diff_sign}{diff})", diff_style),
            ))
        ep_panel = Panel(
            Group(*ep_rows),
            title="Error Patterns",
            border_style="yellow",
        )
    else:
        ep_panel = Panel(
            Text("  No errors", style="dim"),
            title="Error Patterns",
            border_style="yellow",
        )

    console.print(Panel(
        Group(header, Text(), changes_panel, cat_panel, ep_panel),
        border_style="bright_blue",
    ))


def render_submission_validation(validation: dict) -> None:
    """Print a validation checklist for leaderboard submission.

    Expected validation keys:
        valid, checks, warnings, errors
    Each check has: passed (bool), value, message, fix_hint
    """
    console = get_console()

    valid = validation.get("valid", False)
    overall_style = "green" if valid else "red"
    overall_glyph = "✓" if valid else "✗"

    header = Text.assemble(
        (f"  {overall_glyph} ", overall_style),
        ("Submission ", "bold white"),
        ("VALID" if valid else "INVALID", f"bold {overall_style}"),
    )

    # Checks
    check_rows: list[Text] = []
    for name, check in validation.get("checks", {}).items():
        passed = check.get("passed", False)
        glyph = "✓" if passed else "✗"
        style = "green" if passed else "red"
        check_rows.append(Text.assemble(
            (f"  {glyph} ", style),
            (f"{name:20}", "white"),
            (f" {'OK' if passed else 'FAIL'}", style),
        ))

    checks_panel = Panel(
        Group(*check_rows) if check_rows else Text("  No checks", style="dim"),
        title="Checks",
        border_style="blue",
    )

    # Warnings
    warnings = validation.get("warnings", [])
    if warnings:
        warn_rows: list[Text] = []
        for w in warnings:
            warn_rows.append(Text.assemble(
                ("  ⚠ ", "yellow"),
                (f"{w.get('code', '—')}: ", "yellow"),
                (f"{w.get('message', '—')}", "white"),
            ))
        warn_panel = Panel(
            Group(*warn_rows),
            title=f"Warnings ({len(warnings)})",
            border_style="yellow",
        )
    else:
        warn_panel = Panel(
            Text("  No warnings", style="dim"),
            title="Warnings",
            border_style="yellow",
        )

    # Errors
    errors = validation.get("errors", [])
    if errors:
        err_rows: list[Text] = []
        for e in errors:
            err_rows.append(Text.assemble(
                ("  ✗ ", "red"),
                (f"{e.get('code', '—')}: ", "red"),
                (f"{e.get('message', '—')}", "white"),
            ))
        err_panel = Panel(
            Group(*err_rows),
            title=f"Errors ({len(errors)})",
            border_style="red",
        )
    else:
        err_panel = Panel(
            Text("  No errors", style="dim"),
            title="Errors",
            border_style="red",
        )

    # Fix hints (shown if invalid)
    fix_panels: list[Panel] = []
    for name, check in validation.get("checks", {}).items():
        if not check.get("passed") and check.get("fix_hint"):
            fix_panels.append(Panel(
                Text.assemble(
                    (f"  {name}: ", "bold white"),
                    (f"{check['fix_hint']}", "yellow"),
                ),
                border_style="yellow",
            ))

    console.print(Panel(
        Group(header, Text(), checks_panel, warn_panel, err_panel, *fix_panels),
        border_style="bright_blue",
    ))
