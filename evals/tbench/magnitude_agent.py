import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class MagnitudeAgent(BaseInstalledAgent):

    @staticmethod
    def name() -> str:
        return "magnitude"

    async def install(self, environment: BaseEnvironment) -> None:
        """Install the magnitude binary in the container."""
        installed = await self._try_install_from_volume(environment)

        if not installed:
            print("Volume binary not found, falling back to upload...", flush=True)
            binary_path = Path(__file__).parent / "bin" / "magnitude"
            if binary_path.exists():
                await environment.upload_file(
                    source_path=binary_path,
                    target_path="/usr/local/bin/magnitude",
                )
                await self.exec_as_root(
                    environment,
                    command="chmod +x /usr/local/bin/magnitude",
                )
            else:
                # Last resort: install via bun install script
                await self.exec_as_root(
                    environment,
                    command="if ! command -v bun &> /dev/null; then "
                            "curl -fsSL https://bun.sh/install | bash && "
                            "export BUN_INSTALL=$HOME/.bun && "
                            "export PATH=$BUN_INSTALL/bin:$PATH; fi && "
                            "bun install -g @magnitudedev/cli",
                )

        # Ensure CA certificates are available for SSL verification
        await self.exec_as_root(
            environment,
            command="apt-get update -qq && apt-get install -y -qq ca-certificates >/dev/null 2>&1 || true",
        )

        # Upload OAuth credentials if available
        auth_path = Path.home() / ".magnitude" / "auth.json"
        if auth_path.exists():
            await self.exec_as_root(
                environment,
                command="mkdir -p /root/.magnitude",
            )
            await environment.upload_file(
                source_path=auth_path,
                target_path="/root/.magnitude/auth.json",
            )

    async def _try_install_from_volume(self, environment: BaseEnvironment) -> bool:
        """Try to install magnitude from a mounted Daytona volume."""
        current_path = "/opt/magnitude-volume/magnitude/current"

        try:
            result = await environment.exec(command=f"test -f {current_path}")
            if result.return_code != 0:
                return False
        except Exception:
            return False

        print("Installing magnitude from mounted volume...", flush=True)
        try:
            hash_result = await environment.exec(command=f"cat {current_path} | tr -d '\\n'")
            if hash_result.return_code != 0 or not hash_result.stdout or not hash_result.stdout.strip():
                print("Failed to read volume hash pointer", flush=True)
                return False

            binary_hash = hash_result.stdout.strip()
            volume_binary = f"/opt/magnitude-volume/magnitude/sha256/{binary_hash}/magnitude"

            await self.exec_as_root(
                environment,
                command=f"cp {volume_binary} /usr/local/bin/magnitude && chmod +x /usr/local/bin/magnitude",
            )
            return True
        except Exception as e:
            print(f"Failed to copy binary from volume: {e}", flush=True)
            return False

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run magnitude on the task."""
        escaped = shlex.quote(instruction)

        # Build the command
        # Note: exec_as_agent handles set -o pipefail automatically
        cmd = " ".join([
            "magnitude",
            "--headless",
            "--autopilot",
            "--disable-shell-safeguards",
            "--disable-cwd-safeguards",
            "--prompt", escaped,
        ]) + " 2>&1 | tee /logs/agent/magnitude.txt"

        # Only need MAGNITUDE_API_KEY now
        env = {
            "MAGNITUDE_TELEMETRY": "off",
            "MAGNITUDE_API_KEY": os.environ.get("MAGNITUDE_API_KEY", ""),
        }

        # Forward BAML/Boundary env vars if present
        for key in ["BOUNDARY_PROJECT_ID", "BOUNDARY_SECRET", "BOUNDARY_API_KEY"]:
            val = os.environ.get(key, "")
            if val:
                env[key] = val

        await self.exec_as_agent(
            environment,
            command=cmd,
            env=env,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Post-run context population.

        exec_as_agent raises on non-zero exit directly, so error
        detection is handled by Harbor's execution layer. This method
        is kept for API compatibility.
        """
        pass
