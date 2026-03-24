import os

import httpx
from fastapi import APIRouter, Depends

from backend.auth import get_current_user
from backend.models import User

router = APIRouter(prefix="/api/tailscale", tags=["tailscale"])

_SOCKET_PATH = "/var/run/tailscale/tailscaled.sock"


def _socket_available() -> bool:
    return os.path.exists(_SOCKET_PATH)


async def _local_api(path: str) -> dict:
    transport = httpx.AsyncHTTPTransport(uds=_SOCKET_PATH)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://local-tailscaled.sock",
    ) as client:
        resp = await client.get(path, timeout=5.0)
        resp.raise_for_status()
        return resp.json()


@router.get("/status")
async def tailscale_status(_: User = Depends(get_current_user)):
    """Return Tailscale connection status from the local daemon socket.

    Returns {"available": false} when the socket doesn't exist (Tailscale
    sidecar not running) so the frontend can hide the widget gracefully.
    """
    if not _socket_available():
        return {"available": False}

    try:
        raw = await _local_api("/localapi/v0/status")
    except Exception:
        return {"available": False}

    self_node = raw.get("Self", {})
    ips: list[str] = self_node.get("TailscaleIPs", [])

    # DNSName includes a trailing dot from the DNS representation — strip it.
    dns_name: str = self_node.get("DNSName") or ""
    if dns_name.endswith("."):
        dns_name = dns_name[:-1]

    return {
        "available": True,
        "backend_state": raw.get("BackendState"),
        "tailscale_ips": ips,
        "ipv4": next((ip for ip in ips if ":" not in ip), None),
        "ipv6": next((ip for ip in ips if ":" in ip), None),
        "hostname": self_node.get("HostName"),
        "dns_name": dns_name,
        "online": self_node.get("Online", False),
    }
