import logging
import re
import shlex

import asyncssh
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, get_current_user_ws
from backend.database import get_db
from backend.models import Server, User
from backend.ssh_manager import _connect_options, run_command

router = APIRouter(tags=["apt_repos"])
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Security: strict path allowlist to prevent path traversal
# ---------------------------------------------------------------------------

_SOURCES_LIST = "/etc/apt/sources.list"
_SOURCES_LIST_D = "/etc/apt/sources.list.d/"
_FILENAME_RE = re.compile(r'^[a-zA-Z0-9._\-]+\.(list|sources)$')


def _allowed_path(path: str) -> bool:
    """Return True only for /etc/apt/sources.list or /etc/apt/sources.list.d/<safe>.{list,sources}."""
    path = path.strip()
    if path == _SOURCES_LIST:
        return True
    if path.startswith(_SOURCES_LIST_D):
        filename = path[len(_SOURCES_LIST_D):]
        if '/' not in filename and _FILENAME_RE.match(filename):
            return True
    return False


def _deletable_path(path: str) -> bool:
    """Only files inside sources.list.d may be deleted — never sources.list itself."""
    path = path.strip()
    if not path.startswith(_SOURCES_LIST_D):
        return False
    filename = path[len(_SOURCES_LIST_D):]
    return '/' not in filename and _FILENAME_RE.match(filename) is not None


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AptRepoWriteRequest(BaseModel):
    path: str
    content: str


class AptRepoDeleteRequest(BaseModel):
    path: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Read sources.list + all .list/.sources files in sources.list.d in one SSH call.
# ===FILE==> markers separate file boundaries in the combined output.
_READ_CMD = (
    "{ "
    "printf '===FILE==>/etc/apt/sources.list\\n'; "
    "cat /etc/apt/sources.list 2>/dev/null; "
    "for f in $(ls /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null | sort); "
    "do printf '===FILE==>%s\\n' \"$f\"; cat \"$f\" 2>/dev/null; done; "
    "} 2>/dev/null"
)


def _parse_files(output: str) -> list[dict]:
    """Split SSH output at ===FILE==> markers into structured file records."""
    files: list[dict] = []
    current_path: str | None = None
    current_lines: list[str] = []

    for line in output.splitlines(keepends=False):
        if line.startswith("===FILE==>"):
            if current_path is not None:
                files.append({
                    "path": current_path,
                    "content": "\n".join(current_lines).rstrip("\n"),
                    "format": "deb822" if current_path.endswith(".sources") else "one-line",
                    "deletable": _deletable_path(current_path),
                })
            current_path = line[len("===FILE==>"):]
            current_lines = []
        else:
            if current_path is not None:
                current_lines.append(line)

    if current_path is not None:
        files.append({
            "path": current_path,
            "content": "\n".join(current_lines).rstrip("\n"),
            "format": "deb822" if current_path.endswith(".sources") else "one-line",
            "deletable": _deletable_path(current_path),
        })

    return files


# ---------------------------------------------------------------------------
# GET /api/servers/{server_id}/apt-repos — read all source files
# ---------------------------------------------------------------------------

@router.get("/api/servers/{server_id}/apt-repos")
async def get_apt_repos(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    cmd_result = await run_command(server, _READ_CMD, timeout=30)
    files = _parse_files(cmd_result.stdout or "")
    return {"files": files}


# ---------------------------------------------------------------------------
# PUT /api/servers/{server_id}/apt-repos — write a file via sudo tee
# ---------------------------------------------------------------------------

@router.put("/api/servers/{server_id}/apt-repos")
async def write_apt_repo(
    server_id: int,
    body: AptRepoWriteRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    if not _allowed_path(body.path):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Path not allowed")

    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    safe_path = shlex.quote(body.path.strip())
    # Pass content via stdin to sudo tee — avoids any shell escaping issues with file contents
    cmd = f"sudo tee {safe_path} > /dev/null"
    try:
        async with asyncssh.connect(**_connect_options(server)) as conn:
            proc_result = await conn.run(cmd, input=body.content)
    except Exception:
        logger.exception("SSH error writing apt repo file %s on server %d", body.path, server_id)
        raise HTTPException(status_code=500, detail="SSH error writing file")

    if proc_result.exit_status != 0:
        raise HTTPException(status_code=500, detail=f"tee exited with code {proc_result.exit_status}: {proc_result.stderr}")

    return {"ok": True}


# ---------------------------------------------------------------------------
# DELETE /api/servers/{server_id}/apt-repos — remove a file from sources.list.d
# ---------------------------------------------------------------------------

@router.delete("/api/servers/{server_id}/apt-repos")
async def delete_apt_repo(
    server_id: int,
    body: AptRepoDeleteRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    if not _deletable_path(body.path):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Path not allowed — only files inside /etc/apt/sources.list.d/ can be deleted",
        )

    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    safe_path = shlex.quote(body.path.strip())
    cmd_result = await run_command(server, f"sudo rm -f {safe_path}", timeout=15)
    if cmd_result.exit_status != 0:
        raise HTTPException(status_code=500, detail=f"rm failed: {cmd_result.stderr}")

    return {"ok": True}


# ---------------------------------------------------------------------------
# WS /api/ws/apt-repos-test/{server_id} — stream sudo apt-get update
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/apt-repos-test/{server_id}")
async def ws_apt_repos_test(
    server_id: int,
    websocket: WebSocket,
    db: AsyncSession = Depends(get_db),
):
    user = await get_current_user_ws(websocket)
    if user is None:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        await websocket.send_json({"type": "error", "data": "Server not found"})
        await websocket.close()
        return

    async def send_fn(msg: dict) -> None:
        try:
            await websocket.send_json(msg)
        except Exception:
            pass

    try:
        await send_fn({"type": "status", "data": "running"})
        async with asyncssh.connect(**_connect_options(server)) as conn:
            async with conn.create_process("sudo apt-get update", stderr=asyncssh.STDOUT) as proc:
                async for line in proc.stdout:
                    await send_fn({"type": "output", "data": line})
            exit_code = proc.exit_status
        await send_fn({"type": "complete", "data": {"success": exit_code == 0, "exit_code": exit_code}})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        await send_fn({"type": "error", "data": str(exc)})
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
