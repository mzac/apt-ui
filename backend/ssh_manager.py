"""
SSH Manager — async SSH command execution via asyncssh.

Design notes:
- No persistent connection pool. A fresh connection is opened per command.
  The fleet is small (~20 servers) and operations are infrequent (scheduled
  checks + manual upgrades), so connection overhead is negligible compared to
  the cost of maintaining and healing a pool.
- known_hosts=None (host key verification disabled). The app operates on a
  trusted private network and managing known_hosts across a dynamic fleet
  would add operational friction without meaningful security benefit in this
  deployment model. The private key provides one-way authentication assurance.
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

import asyncssh

from backend.config import SSH_PRIVATE_KEY

if TYPE_CHECKING:
    from backend.models import Server

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT = 15  # seconds — give up connecting after this long


@dataclass
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int

    @property
    def success(self) -> bool:
        return self.exit_code == 0


def _load_private_key() -> asyncssh.SSHKey | None:
    """Parse the SSH private key from the env var once at call time."""
    if not SSH_PRIVATE_KEY:
        logger.warning("SSH_PRIVATE_KEY is not set — SSH operations will fail")
        return None
    try:
        return asyncssh.import_private_key(SSH_PRIVATE_KEY)
    except Exception as exc:
        logger.error("Failed to parse SSH_PRIVATE_KEY: %s", exc)
        return None


def _connect_options(server: "Server") -> dict:
    """Build asyncssh connection keyword arguments for a server."""
    key = _load_private_key()
    return {
        "host": server.hostname,
        "port": server.ssh_port,
        "username": server.username,
        "client_keys": [key] if key else [],
        "known_hosts": None,  # see module docstring
        "connect_timeout": CONNECT_TIMEOUT,
    }


async def run_command(
    server: "Server",
    command: str,
    timeout: int = 60,
) -> CommandResult:
    """
    Open a fresh SSH connection, run *command*, return a CommandResult.

    Never raises — connection errors are captured as a non-zero exit_code
    with the error text in stderr.
    """
    try:
        async with asyncssh.connect(**_connect_options(server)) as conn:
            result = await asyncio.wait_for(
                conn.run(command, check=False),
                timeout=timeout,
            )
        return CommandResult(
            stdout=result.stdout or "",
            stderr=result.stderr or "",
            exit_code=result.exit_status if result.exit_status is not None else 1,
        )
    except asyncio.TimeoutError:
        msg = f"Command timed out after {timeout}s"
        logger.warning("Server %s — %s", server.hostname, msg)
        return CommandResult(stdout="", stderr=msg, exit_code=124)
    except asyncssh.DisconnectError as exc:
        msg = f"SSH disconnected: {exc}"
        logger.warning("Server %s — %s", server.hostname, msg)
        return CommandResult(stdout="", stderr=msg, exit_code=255)
    except (asyncssh.ConnectionLost, OSError) as exc:
        msg = f"Connection failed: {exc}"
        logger.warning("Server %s — %s", server.hostname, msg)
        return CommandResult(stdout="", stderr=msg, exit_code=255)
    except Exception as exc:
        msg = f"Unexpected SSH error: {exc}"
        logger.exception("Server %s — %s", server.hostname, msg)
        return CommandResult(stdout="", stderr=msg, exit_code=255)


async def run_command_stream(
    server: "Server",
    command: str,
    send_fn,
    timeout: int = 3600,
) -> CommandResult:
    """
    Run *command* and stream stdout/stderr over a WebSocket in real time.

    *send_fn* is an async callable that accepts a JSON-serialisable dict,
    e.g.:  await send_fn({"type": "output", "data": line})

    Returns a CommandResult with accumulated stdout/stderr.
    """
    stdout_buf: list[str] = []
    stderr_buf: list[str] = []

    async def _drain_reader(reader, is_stderr: bool):
        async for line in reader:
            text = line if isinstance(line, str) else line.decode("utf-8", errors="replace")
            if is_stderr:
                stderr_buf.append(text)
            else:
                stdout_buf.append(text)
            await send_fn({"type": "output", "data": text})

    try:
        async with asyncssh.connect(**_connect_options(server)) as conn:
            async with conn.create_process(
                command,
                stderr=asyncssh.STDOUT,  # merge stderr into stdout for terminal feel
            ) as process:
                await asyncio.wait_for(
                    _drain_reader(process.stdout, is_stderr=False),
                    timeout=timeout,
                )
                await process.wait_closed()
                exit_code = process.exit_status if process.exit_status is not None else 1

        return CommandResult(
            stdout="".join(stdout_buf),
            stderr="".join(stderr_buf),
            exit_code=exit_code,
        )

    except asyncio.TimeoutError:
        msg = f"Command timed out after {timeout}s"
        await send_fn({"type": "error", "data": msg})
        return CommandResult(stdout="".join(stdout_buf), stderr=msg, exit_code=124)
    except Exception as exc:
        msg = f"SSH error: {exc}"
        await send_fn({"type": "error", "data": msg})
        logger.warning("Server %s stream error — %s", server.hostname, msg)
        return CommandResult(stdout="".join(stdout_buf), stderr=msg, exit_code=255)


async def test_connection(server: "Server") -> CommandResult:
    """Quick connectivity test — runs `echo ok` and returns the result."""
    return await run_command(server, "echo ok", timeout=CONNECT_TIMEOUT)
