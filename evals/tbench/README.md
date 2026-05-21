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
```

> **Tip:** The interactive runner (`bun evals/tbench/run.ts`) adds these flags automatically when you select a cloud environment.

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
