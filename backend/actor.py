"""Ambient "who initiated this action" identity, threaded via a ContextVar.

WebSocket / request handlers call set_actor(username) after authenticating; the SSH
audit log and upgrade-history writers read get_actor() instead of hard-coding "system".
ContextVars propagate into coroutines and tasks spawned from the same context
(asyncio.create_task / gather copy the current context), so per-server fan-out keeps
the right actor. Background/scheduled jobs never set it, so they remain "system".
"""
import contextvars

_actor: contextvars.ContextVar[str] = contextvars.ContextVar("apt_ui_actor", default="system")


def set_actor(name: str | None) -> None:
    _actor.set(name or "system")


def get_actor() -> str:
    try:
        return _actor.get() or "system"
    except LookupError:
        return "system"
