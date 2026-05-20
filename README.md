<p align="center">
  <img src="wordmark.svg" alt="Magnitude" width="100%" />
</p>

<p align="center">
  <a href="https://docs.magnitude.dev" target="_blank"><img src="https://img.shields.io/badge/📕-Docs-232f41?style=flat-square&labelColor=0369a1&color=gray" alt="Documentation" /></a> <a href="https://app.magnitude.dev" target="_blank"><img src="https://img.shields.io/badge/%F0%9F%96%A5-Console-232f41?style=flat-square&labelColor=0369a1&color=gray" alt="Console" /></a> <img src="https://img.shields.io/badge/License-Apache%202.0-232f41?style=flat-square&labelColor=0369a1&color=gray" alt="License" /> <a href="https://discord.gg/VcdpMh9tTy" target="_blank"><img src="https://img.shields.io/badge/-Join%20community-gray?style=flat-square&logo=discord&logoColor=white&labelColor=5865F2" alt="Join community" /></a> <a href="https://x.com/usemagnitude" target="_blank"><img src="https://img.shields.io/badge/-Follow%20Magnitude-000000?style=flat-square&labelColor=000000&color=gray&logo=x&logoColor=white" alt="Follow Magnitude" /></a>
</p>

<p align="center">
  <strong>The best coding agent for open models</strong>
</p>

Magnitude is built from the ground up around open models. It matches the performance of Claude Code at 5x lower token prices.

- **Easy setup** — One API key and you're up and running.
- **Reliable** — We fix common open model failure modes.
- **Best models** — We constantly test new model setups.
- **Web search** — Built-in web search that is fast and reliable.
- **Private** — Zero data retention on your prompts and code.
- **Transparent** — API prices with no markup, $5 free credits.

<p align="center">
  <img src="interface.png" alt="Magnitude interface" width="100%" />
</p>

## Get started

1. Run `npm i -g @magnitudedev/cli` in the terminal
2. Run `magnitude` which will ask for an API key
3. Sign up at [app.magnitude.dev](https://app.magnitude.dev) to get your free API key

> If you are on Windows, you will need to use `wsl`.

$5 of free credits to start, no card required. API pricing with no markup after that.

Want to chat about your use case for open models? [Book a call with our founder](https://calendly.com/tom-magnitude/30min)

## What's under the hood?

- **Constrained decoding.** Custom GBNF grammar that prevents common open model failure modes like overthinking and malformed tool calls.
- **Robust streaming parser.** Speculative execution with rollback resolves ambiguous decision points that break naive parsers on open model output.
- **Harness reliability.** Mid-stream schema validation and structured error feedback ensure the model always gets a corrective signal to work off.

### Specialized agents

Magnitude is a curated system of specialized agents, each with its own defined role. These agents are made up of a system prompt, specific context, scoped toolsets, and a dedicated model + reasoning level. Here's the agents we include:

- **Leader.** Talks to the user and delegates work. **Model:** GLM 5.1.
- **Scout.** Fast and efficient exploration. **Model:** Kimi K2.5.
- **Architect.** Plans and high-level design thinking. **Model:** Kimi K2.6.
- **Engineer.** Concrete planning and implementation. **Model:** Kimi K2.6.
- **Critic.** Critical and detail-oriented analysis. **Model:** Kimi K2.6.
- **Scientist.** Empirical debugging and information gathering. **Model:** Kimi K2.6.

## Acknowledgments

Built on top of [Effect](https://effect.website) and [OpenTUI](https://github.com/anomalyco/opentui).
