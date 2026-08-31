import logging
import re
import shlex

import asyncssh
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.actor import set_actor
from backend.auth import get_current_user, require_admin, get_current_user_ws
from backend.database import AsyncSessionLocal, get_db
from backend.models import Server, User
from backend.ssh_manager import _connect_options, apt_prefix, run_command, sudo_prefix

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
# ===FILE==> markers separate file boundaries in the combined output. ===BACKUP==> marks the
# single-generation pre-save backup written by write_apt_repo() below (a ".apt-ui-bak"
# sibling), when one exists, so a previous version survives a page reload — the backup
# filename never matches _FILENAME_RE (it doesn't end in .list/.sources) so it's never
# listed as an editable file of its own.
_BACKUP_SUFFIX = ".apt-ui-bak"

_READ_CMD = (
    "{ "
    "printf '===FILE==>/etc/apt/sources.list\\n'; "
    "cat /etc/apt/sources.list 2>/dev/null; "
    "[ -f /etc/apt/sources.list" + _BACKUP_SUFFIX + " ] && { "
    "printf '===BACKUP==>/etc/apt/sources.list\\n'; cat /etc/apt/sources.list" + _BACKUP_SUFFIX + " 2>/dev/null; }; "
    "for f in $(ls /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null | sort); "
    "do printf '===FILE==>%s\\n' \"$f\"; cat \"$f\" 2>/dev/null; "
    "[ -f \"$f" + _BACKUP_SUFFIX + "\" ] && { printf '===BACKUP==>%s\\n' \"$f\"; cat \"$f" + _BACKUP_SUFFIX + "\" 2>/dev/null; }; "
    "done; "
    "} 2>/dev/null"
)


def _parse_files(output: str) -> list[dict]:
    """Split SSH output at ===FILE==>/===BACKUP==> markers into structured file records."""
    file_content: dict[str, str] = {}
    backup_content: dict[str, str] = {}
    order: list[str] = []

    current_path: str | None = None
    current_kind: str | None = None  # "file" | "backup"
    current_lines: list[str] = []

    def _flush() -> None:
        if current_path is None or current_kind is None:
            return
        text = "\n".join(current_lines).rstrip("\n")
        if current_kind == "file":
            file_content[current_path] = text
            if current_path not in order:
                order.append(current_path)
        else:
            backup_content[current_path] = text

    for line in output.splitlines(keepends=False):
        if line.startswith("===FILE==>"):
            _flush()
            current_path = line[len("===FILE==>"):]
            current_kind = "file"
            current_lines = []
        elif line.startswith("===BACKUP==>"):
            _flush()
            current_path = line[len("===BACKUP==>"):]
            current_kind = "backup"
            current_lines = []
        else:
            if current_path is not None:
                current_lines.append(line)
    _flush()

    files: list[dict] = []
    for path in order:
        files.append({
            "path": path,
            "content": file_content[path],
            "format": "deb822" if path.endswith(".sources") else "one-line",
            "deletable": _deletable_path(path),
            "backup_content": backup_content.get(path),
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
    safe_backup_path = shlex.quote(body.path.strip() + _BACKUP_SUFFIX)
    sudo = sudo_prefix(server)

    # Best-effort single-generation backup: snapshot whatever is currently on disk before we
    # overwrite it, so a bad edit can be restored without retyping and without depending on
    # session-only frontend state (issue #62). Not a version history — each save overwrites
    # the previous backup. Silently skipped if the file doesn't exist yet (new file) or the
    # read/write fails; it must never block the actual save. Read via `sudo cat` (some
    # sources files may not be world-readable) and write via `sudo tee` with stdin, same
    # idiom as the real write below — a shell redirection (`cat x > y`) would run as the
    # unprivileged SSH user even under `sudo sh -c '...'`, since only the command sudo
    # actually execs is privileged, not the calling shell's own redirection.
    old_result = await run_command(server, f"{sudo}cat {safe_path} 2>/dev/null", timeout=15)
    if old_result.exit_code == 0:
        try:
            async with asyncssh.connect(**_connect_options(server)) as backup_conn:
                await backup_conn.run(f"{sudo}tee {safe_backup_path} > /dev/null", input=old_result.stdout)
        except Exception:
            logger.warning("Could not write pre-save backup for %s on server %d", body.path, server_id)

    # Pass content via stdin to tee — avoids any shell escaping issues with file contents
    cmd = f"{sudo}tee {safe_path} > /dev/null"
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
    _: User = Depends(require_admin),
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
    cmd_result = await run_command(server, f"{sudo_prefix(server)}rm -f {safe_path}", timeout=15)
    if cmd_result.exit_code != 0:
        raise HTTPException(status_code=500, detail=f"rm failed: {cmd_result.stderr}")

    return {"ok": True}


# ---------------------------------------------------------------------------
# WS /api/ws/apt-repos-test/{server_id} — stream sudo apt-get update
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/apt-repos-test/{server_id}")
async def ws_apt_repos_test(websocket: WebSocket, server_id: int):
    await websocket.accept()

    token = websocket.cookies.get("apt_ui_token") or websocket.query_params.get("token")
    async with AsyncSessionLocal() as db:
        user = await get_current_user_ws(token or "", db)
        if user is None:
            await websocket.close(code=1008)
            return
        set_actor(user.username)

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
                async with conn.create_process(
                    f"{apt_prefix(server)}apt-get update", stderr=asyncssh.STDOUT
                ) as proc:
                    async for line in proc.stdout:
                        await send_fn({"type": "output", "data": line})
                    await proc.wait_closed()
                    exit_code = proc.exit_status if proc.exit_status is not None else 1
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
