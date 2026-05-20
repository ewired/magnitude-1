# Terminal Bench 2.1 Evaluation

Run Magnitude on [Terminal Bench 2.1](https://www.tbench.ai/) via [Harbor](https://github.com/harbor-framework/harbor).

## Prerequisites

- **Docker** (OrbStack, Docker Desktop, etc.)
- **Harbor**: `uv tool install harbor`
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

### Daytona Cloud

Pre-seed the binary into a Daytona volume first:

```bash
python3 evals/tbench/seed_daytona_volume.py
```

Then run with cloud environment:

```bash
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  --env daytona \
  --environment-kwarg volumes=magnitude-binaries \
  -n 100
```

## View results

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

Visualize in browser:

```bash
harbor view jobs/2026-05-19__23-55-14 --jobs
```

Opens `http://127.0.0.1:8080`.
