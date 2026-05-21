# Terminal Bench 2.1 Evaluation

Run Magnitude on [Terminal Bench 2.1](https://www.tbench.ai/) via [Harbor](https://github.com/harbor-framework/harbor).

## Prerequisites

- **Docker** (OrbStack, Docker Desktop, etc.)
- **Harbor**: `uv tool install 'harbor[modal]'`
- **Magnitude API key**: `export MAGNITUDE_API_KEY=...`

## Build the Linux binary

TB2 containers run Linux x64. Build the binary once:

```bash
./evals/tbench/build-linux.sh
```

Output: `evals/tbench/bin/magnitude`

## Run

### Local Docker

```bash
# Single task (testing)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  -l 1

# Full benchmark (4 concurrent)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  -n 4

# Specific task
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  -i "terminal-bench/fix-git"
```

### Modal Cloud

Requires `uv tool install 'harbor[modal]'` and Modal credentials (`MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`).

Pre-seed the binary into a Modal volume:

```bash
modal run evals/tbench/seed_modal_volume.py
```

Then run. **Both `--env modal` and `--environment-kwarg` are required** — without them the volume won't be mounted and the agent will fall back to uploading the binary on every trial:

```bash
# Single task
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  --env modal \
  --environment-kwarg 'volumes={"/magnitude-binaries":"magnitude-binaries"}' \
  -i "terminal-bench/fix-git"

# Full benchmark (100 concurrent)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  --env modal \
  --environment-kwarg 'volumes={"/magnitude-binaries":"magnitude-binaries"}' \
  -n 100

# All easy tasks, 3 trials each
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  --env modal \
  --environment-kwarg 'volumes={"/magnitude-binaries":"magnitude-binaries"}' \
  -k 3 \
  -i "terminal-bench/cobol-modernization" \
  -i "terminal-bench/fix-git" \
  -i "terminal-bench/overfull-hbox" \
  -i "terminal-bench/prove-plus-comm"
```

> **Tip:** The interactive runner (`bun evals/tbench/run.ts`) adds these flags automatically when you select a cloud environment.

## tbench CLI

The `tbench` command provides analysis and management utilities on top of Harbor.

```bash
# Install (from project root)
cd ~/magnitude
uv run --project evals/tbench tbench --help
```

### List jobs & tasks

```bash
tbench jobs                         # recent jobs with pass/fail/mean/runtime
tbench jobs --since 2026-05-20      # only jobs after a date
tbench jobs --limit 5               # show fewer
tbench tasks                        # all 89 TB2 tasks with description, difficulty, tags
tbench tasks --category security     # filter by category
tbench tasks --difficulty hard       # filter by difficulty
```

### Inspect a task

```bash
tbench tasks fix-git               # full details: instruction, metadata, tbench.ai link
tbench tasks fix-git --open-link   # opens in browser
```

### Job results

```bash
tbench show                       # latest completed job — pass/fail/mean/regressions
tbench show 2026-05-20__17-29-34  # specific job
tbench inspect <job> fix-git      # ATIF timeline for a failed task
tbench inspect <job> fix-git --errors-only   # only error steps
tbench logs <job> fix-git         # raw agent log
tbench logs <job> fix-git --follow          # tail -f
```

### Compare runs

```bash
tbench diff                       # last two same-binary jobs
tbench diff <job-a> <job-b>       # specific pair
tbench diff --task fix-git        # diff only one task
```

### Build & deploy

```bash
tbench build                      # build Linux binary (skips if up-to-date)
tbench build --force              # always rebuild
tbench build --check              # just check staleness
tbench seed                       # upload binary to Modal volume
tbench seed --force               # re-upload even if hash matches
```

### JSON output

All commands support `TBENCH_JSON=1` for machine-readable output:

```bash
TBENCH_JSON=1 tbench ls | jq .
TBENCH_JSON=1 tbench show | jq '.overview'
```

## View results

Visualize jobs in browser:
```
harbor view jobs
```
Opens `http://127.0.0.1:8080`.

Harbor stores runs under `./jobs/`:

```
jobs/
  2026-05-19__23-55-14/       ← job dir
    fix-git__FW5CS7V/          ← trial dir
      agent/
        magnitude.txt          ← agent log
      trajectory.json          ← ATIF trajectory
      result.json
    job.log
    result.json
```
