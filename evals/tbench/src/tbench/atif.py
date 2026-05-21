"""ATIF trajectory summarizer and extractor.

Wraps Harbor's Pydantic ATIF models to produce human- and LLM-digestible
summaries, timelines, and error analysis.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from harbor.models.trajectories.trajectory import Trajectory
from harbor.models.trajectories.step import Step
from harbor.models.trajectories.tool_call import ToolCall
from harbor.models.trajectories.observation import Observation
from harbor.models.trajectories.metrics import Metrics
from harbor.models.trajectories.final_metrics import FinalMetrics


# ---------------------------------------------------------------------------
# Pydantic output models
# ---------------------------------------------------------------------------

class TrajectorySummary(BaseModel):
    """Aggregate statistics for a Trajectory."""

    total_steps: int = Field(description="Number of steps in the trajectory")
    agent_steps: int = Field(description="Steps where source == 'agent'")
    tool_call_steps: int = Field(description="Steps with at least one tool call")
    tool_call_count: int = Field(description="Total number of tool calls")
    error_steps: list[int] = Field(description="Step indices (1-based) where errors occurred")
    final_step_index: int = Field(description="Index of the last step")
    cost_usd: float | None = Field(description="Total cost in USD from final_metrics")
    prompt_tokens: int | None = Field(description="Total prompt tokens from final_metrics")
    completion_tokens: int | None = Field(description="Total completion tokens from final_metrics")
    cached_tokens: int | None = Field(description="Total cached tokens from final_metrics")
    agent_name: str | None = Field(description="Agent name from trajectory metadata")
    agent_model: str | None = Field(description="Model name from trajectory metadata")
    has_subagent_trajectories: bool = Field(description="Whether subagent trajectories exist")


class TimelineEntry(BaseModel):
    """A single entry in the narrative timeline."""

    step: int = Field(description="1-based step index")
    source: str = Field(description="Step source: system, user, or agent")
    type: str = Field(
        description="Categorized type: instruction, reasoning, tool_call, error, or observation"
    )
    summary: str = Field(description="Human-readable one-line summary")
    tool: str | None = Field(description="Tool name if this is a tool_call step")
    error: dict[str, Any] | None = Field(description="Error details if present")
    note: str | None = Field(description="Optional contextual note (e.g. 'final step')")


# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------

def load_trajectory(path: Path) -> Trajectory:
    """Load and parse a trajectory.json file.

    Args:
        path: Path to a trajectory.json file (str or Path).

    Returns:
        A validated Harbor Trajectory Pydantic model.
    """
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    return Trajectory.model_validate_json(text)


# ---------------------------------------------------------------------------
# Summarize
# ---------------------------------------------------------------------------

def summarize_trajectory(traj: Trajectory) -> TrajectorySummary:
    """Aggregate stats from a Trajectory.

    Args:
        traj: Harbor Trajectory model.

    Returns:
        TrajectorySummary with counts, tokens, costs, and error indices.
    """
    steps = traj.steps or []
    agent_steps = sum(1 for s in steps if s.source == "agent")
    tool_call_steps = sum(
        1 for s in steps if s.tool_calls is not None and len(s.tool_calls) > 0
    )
    tool_call_count = sum(
        len(s.tool_calls) for s in steps if s.tool_calls is not None
    )
    error_steps = find_error_steps(traj)

    fm = traj.final_metrics
    cost_usd = fm.total_cost_usd if fm else None
    prompt_tokens = fm.total_prompt_tokens if fm else None
    completion_tokens = fm.total_completion_tokens if fm else None
    cached_tokens = fm.total_cached_tokens if fm else None

    agent = traj.agent
    agent_name = agent.name if agent else None
    agent_model = agent.model_name if agent else None

    has_subagents = bool(
        traj.subagent_trajectories and len(traj.subagent_trajectories) > 0
    )

    return TrajectorySummary(
        total_steps=len(steps),
        agent_steps=agent_steps,
        tool_call_steps=tool_call_steps,
        tool_call_count=tool_call_count,
        error_steps=error_steps,
        final_step_index=len(steps),
        cost_usd=cost_usd,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cached_tokens=cached_tokens,
        agent_name=agent_name,
        agent_model=agent_model,
        has_subagent_trajectories=has_subagents,
    )


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------

def build_timeline(traj: Trajectory, errors_only: bool = False) -> list[TimelineEntry]:
    """Build a narrative step list with summaries and error context.

    Args:
        traj: Harbor Trajectory model.
        errors_only: If True, include only error steps and their immediate
            neighbours (±2 steps of context).

    Returns:
        List of TimelineEntry objects, ordered by step index.
    """
    steps = traj.steps or []
    entries: list[TimelineEntry] = []

    error_indices = {i for i in find_error_steps(traj)}

    if errors_only:
        include_indices = set()
        for idx in error_indices:
            for offset in range(-2, 3):
                include_indices.add(idx - 1 + offset)
        include_indices = {i for i in include_indices if 0 <= i < len(steps)}
    else:
        include_indices = set(range(len(steps)))

    for i, step in enumerate(steps):
        if i not in include_indices:
            continue

        entry = _step_to_timeline_entry(step, i + 1)
        if i + 1 in error_indices and not entry.error:
            # In case _step_to_timeline_entry missed it, mark it
            entry.error = {"detected": True, "note": "Error detected in this step"}
        if i + 1 == len(steps) and i + 1 in error_indices:
            entry.note = "Final step before timeout — no resolution" if not entry.note else entry.note
        entries.append(entry)

    return entries


def _step_to_timeline_entry(step: Step, step_number: int) -> TimelineEntry:
    """Convert a single Step into a TimelineEntry."""
    source = step.source or "unknown"
    summary = format_step(step, truncate=True)
    tool: str | None = None
    error: dict[str, Any] | None = None
    note: str | None = None

    # Determine type and extract tool/error info
    if step.tool_calls:
        type_ = "tool_call"
        # Pick the first tool call name as representative
        tool = step.tool_calls[0].function_name if step.tool_calls else None
        # Check observation for error indicators
        if step.observation and step.observation.results:
            for res in step.observation.results:
                content = res.content or ""
                # Heuristic: common error patterns in observation content
                lowered = content.lower()
                if any(
                    marker in lowered
                    for marker in (
                        "error",
                        "exception",
                        "traceback",
                        "failed",
                        "exit code",
                        "exit status",
                        "curl: (",
                        "connection refused",
                        "permission denied",
                        "command not found",
                        "no such file",
                    )
                ):
                    error = {
                        "observation_snippet": content[:300],
                        "source_call_id": res.source_call_id,
                    }
    elif source == "system":
        type_ = "instruction"
    elif source == "user":
        type_ = "instruction"
    else:
        type_ = "reasoning"

    # Detect metrics-level errors (non-zero cost but no completion, etc.)
    if step.metrics and step.metrics.cost_usd is not None and step.metrics.completion_tokens == 0:
        # This can indicate a failed / errored LLM call, but only flag if we
        # don't already have an error and there are tool calls.
        if not error and step.tool_calls:
            error = {"note": "Zero completion tokens despite tool call"}

    # Note if this is the final step and looks incomplete
    # (caller handles final-step annotation in build_timeline)

    return TimelineEntry(
        step=step_number,
        source=source,
        type=type_,
        summary=summary,
        tool=tool,
        error=error,
        note=note,
    )


# ---------------------------------------------------------------------------
# Tool usage
# ---------------------------------------------------------------------------

def extract_tool_usage(traj: Trajectory) -> dict[str, int]:
    """Count tool calls by function name.

    Args:
        traj: Harbor Trajectory model.

    Returns:
        Mapping from tool function name to call count.
    """
    counts: dict[str, int] = {}
    for step in traj.steps or []:
        for tc in step.tool_calls or []:
            name = tc.function_name or "unknown"
            counts[name] = counts.get(name, 0) + 1
    return counts


# ---------------------------------------------------------------------------
# Error detection
# ---------------------------------------------------------------------------

def find_error_steps(traj: Trajectory) -> list[int]:
    """Return 1-based step indices where errors occurred.

    Heuristics:
        - Observation content contains error markers.
        - Tool call results with non-empty stderr-like content.
        - Zero completion tokens on agent steps with tool calls.

    Args:
        traj: Harbor Trajectory model.

    Returns:
        List of 1-based step indices with detected errors.
    """
    indices: list[int] = []
    for i, step in enumerate(traj.steps or []):
        if _step_has_error(step):
            indices.append(i + 1)
    return indices


def _step_has_error(step: Step) -> bool:
    """Return True if the step contains an error signal."""
    # Check observation results for error markers
    if step.observation and step.observation.results:
        for res in step.observation.results:
            content = (res.content or "").lower()
            if any(
                marker in content
                for marker in (
                    "error",
                    "exception",
                    "traceback",
                    "failed",
                    "exit code",
                    "exit status",
                    "curl: (",
                    "connection refused",
                    "permission denied",
                    "command not found",
                    "no such file",
                )
            ):
                return True

    # Check for zero-completion-token anomaly on agent steps with tool calls
    if (
        step.source == "agent"
        and step.tool_calls
        and step.metrics
        and step.metrics.completion_tokens == 0
    ):
        return True

    return False


# ---------------------------------------------------------------------------
# Step formatting
# ---------------------------------------------------------------------------

def format_step(step: Step, truncate: bool = True) -> str:
    """Human-readable one-line step summary.

    Args:
        step: Harbor Step model.
        truncate: If True, cap message / reasoning at ~120 chars.

    Returns:
        One-line summary string.
    """
    source = step.source or "unknown"

    if step.tool_calls:
        # Tool call step — list the tools
        names = [tc.function_name or "unknown" for tc in step.tool_calls]
        args_snippets: list[str] = []
        for tc in step.tool_calls:
            args = tc.arguments
            if isinstance(args, dict):
                # Pick a representative arg for brevity
                for key in ("command", "path", "file_path", "url", "query"):
                    if key in args and args[key]:
                        val = str(args[key])
                        if truncate and len(val) > 40:
                            val = val[:37] + "..."
                        args_snippets.append(f"{key}={val}")
                        break
                else:
                    first_key = next(iter(args.keys()), None)
                    if first_key:
                        val = str(args[first_key])
                        if truncate and len(val) > 40:
                            val = val[:37] + "..."
                        args_snippets.append(f"{first_key}={val}")
            elif isinstance(args, str):
                val = args if not truncate or len(args) <= 40 else args[:37] + "..."
                args_snippets.append(val)

        tools_str = "  ".join(
            f"{name}({args})" if args else name
            for name, args in zip(names, args_snippets)
        )
        return f"{source}  →  {tools_str}"

    # Non-tool step — summarize message / reasoning content
    text = step.message or step.reasoning_content or ""
    text = text.strip().replace("\n", " ")
    if truncate and len(text) > 120:
        text = text[:117] + "..."
    if not text:
        text = "(no content)"
    return f"{source}  →  {text}"
