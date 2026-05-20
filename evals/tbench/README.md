# Terminal Bench 2.1 Evaluation

Run Magnitude on [Terminal Bench 2.1](https://www.tbench.ai/) via the [Harbor](https://github.com/harbor-framework/harbor) framework.

## Overview

Terminal Bench 2.1 (TB2.1) is a benchmark for evaluating AI agents on realistic, end-to-end CLI tasks in sandboxed Docker containers. It is a revision of TB2.0 that fixes 26 tasks for bugs, timeouts, and reward hacking robustness. Each task provides:

- A Docker environment with pre-loaded files
- A natural language instruction
- Test scripts that verify the final container state

Harbor is the official harness for running TB2. It manages container lifecycle, agent execution, and verification.

## Files

| File | Purpose |
|------|---------|
| `magnitude_agent.py` | Harbor adapter — uploads the prebuilt Magnitude binary into TB2 containers and invokes it |
| `Dockerfile.build` | Docker image definition for building the Linux x64 Magnitude binary |
| `build-linux.sh` | Helper script to build the Docker image and extract `evals/tbench/bin/magnitude` |
| `bin/` | Local output directory for the built Linux x64 binary (ignored by git) |

## Prerequisites

- **Docker** running locally (e.g. OrbStack, Docker Desktop)
- **Harbor** installed: `pip install harbor` or `uv tool install harbor`
- **Magnitude API key** — set `MAGNITUDE_API_KEY` (model resolution is handled by the Magnitude API)

## Quick Start

```bash
# 1. Build the Linux binary (from repo root)
./evals/tbench/build-linux.sh

# 2. Set your API key
export MAGNITUDE_API_KEY=...
```

Then choose your execution environment:

### Local Docker

The agent uploads the binary directly into each container. No extra steps needed.

```bash
# Interactive wrapper
bun evals/tbench/cli.ts run

# Or directly:
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  -l 1
```

### Daytona Cloud

For parallel runs at scale. You must pre-seed a Daytona volume with the binary before running.

```bash
# 1. Seed the Daytona volume (only needed once per binary build)
python3 evals/tbench/seed_daytona_volume.py
# Or via the CLI wrapper:
bun evals/tbench/cli.ts seed-volume

# 2. Run with the daytona environment
bun evals/tbench/cli.ts run --env daytona

# Or directly:
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  --env daytona \
  --environment-kwarg volumes=magnitude-binaries \
  -n 100
```

The runner automatically passes `--environment-kwarg volumes=magnitude-binaries` when using a cloud environment. The agent's `install()` method checks the volume mount first, then falls back to direct upload.

### Common harbor commands

```bash
# Run a single task (good for testing)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  -l 1

# Run the full benchmark (4 concurrent)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  -n 4

# Run a specific task (task names are prefixed with terminal-bench/)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent \
  -i "terminal-bench/fix-git"
```

## Building the Linux Binary

Magnitude's CLI binary is built with Bun's native compiler. Since TB2 containers run Linux x64, build the binary in Docker from the repo root:

```bash
./evals/tbench/build-linux.sh
```

The script will:

1. Build `evals/tbench/Dockerfile.build` with the repo root as the Docker build context
2. Run `bun install` inside the image
3. Run `bun run cli/scripts/build-binary.ts bun-linux-x64`
4. Extract the resulting binary to `evals/tbench/bin/magnitude`
5. Mark the extracted binary executable

If `evals/tbench/bin/magnitude` exists, the adapter uploads it directly into the container (fast). Otherwise, it falls back to installing Magnitude via bun inside the container.

## How It Works

1. **Harbor** spins up a Docker container per task with the task environment pre-loaded
2. **Install**: The adapter uploads `evals/tbench/bin/magnitude` into the container at `/usr/local/bin/magnitude`
3. **Run**: Harbor executes `magnitude --headless --autopilot --disable-shell-safeguards --disable-cwd-safeguards --prompt "<instruction>"`
4. **Magnitude** operates on the container filesystem — reads/edits files, runs shell commands
5. **Verification**: Harbor runs the task's test scripts against the final container state

## Configuration

### API Key

Set `MAGNITUDE_API_KEY` — Magnitude resolves the model automatically through its API catalog based on your account. No provider-specific keys are needed.

```bash
export MAGNITUDE_API_KEY=...
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.tbench.magnitude_agent:MagnitudeAgent
```

### Useful flags

| Flag | Description |
|------|-------------|
| `-l <n>` | Limit to n tasks |
| `-n <n>` | Run n tasks concurrently (default: 4) |
| `-i <pattern>` | Include specific task(s) by name/glob |
| `-x <pattern>` | Exclude task(s) by name/glob |
| `--timeout-multiplier <f>` | Scale task timeouts |
| `--debug` | Enable debug logging |

## Verifying the Setup

Run the oracle agent (no API key needed) to confirm Harbor + TB2 works:

```bash
harbor run -d terminal-bench/terminal-bench-2-1 -a oracle -l 1
```

Expected output: 1 trial, reward = 1.0, 0 errors.
