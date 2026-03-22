"""
Unified notification module — email (aiosmtplib) + Telegram (httpx).

Both channels are optional and controlled by notification_config in the DB.
"""

import json
import logging
from datetime import datetime, date
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import aiosmtplib
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import NotificationConfig, Server, UpdateCheck, UpdateHistory

logger = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"
MAX_TELEGRAM_LEN = 4000  # leave buffer below 4096


# ---------------------------------------------------------------------------
# Low-level send helpers
# ---------------------------------------------------------------------------

async def _send_email(cfg: NotificationConfig, subject: str, html_body: str, text_body: str):
    if not cfg.email_enabled or not cfg.smtp_host or not cfg.email_to:
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = cfg.email_from or cfg.smtp_username or "apt-dashboard@localhost"
    msg["To"] = cfg.email_to

    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    use_ssl = cfg.smtp_port == 465
    try:
        await aiosmtplib.send(
            msg,
            hostname=cfg.smtp_host,
            port=cfg.smtp_port,
            username=cfg.smtp_username or None,
            password=cfg.smtp_password or None,
            use_tls=use_ssl,
            start_tls=cfg.smtp_use_tls and not use_ssl,
        )
        logger.info("Email sent: %s", subject)
    except Exception as exc:
        logger.error("Email send failed: %s", exc)


async def _send_telegram(cfg: NotificationConfig, text: str):
    if not cfg.telegram_enabled or not cfg.telegram_bot_token or not cfg.telegram_chat_id:
        return

    url = TELEGRAM_API.format(token=cfg.telegram_bot_token, method="sendMessage")

    # Split into chunks if too long
    chunks = []
    while len(text) > MAX_TELEGRAM_LEN:
        split_at = text.rfind("\n", 0, MAX_TELEGRAM_LEN)
        if split_at == -1:
            split_at = MAX_TELEGRAM_LEN
        chunks.append(text[:split_at])
        text = text[split_at:].lstrip("\n")
    chunks.append(text)

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            for chunk in chunks:
                resp = await client.post(url, json={
                    "chat_id": cfg.telegram_chat_id,
                    "text": chunk,
                    "parse_mode": "Markdown",
                })
                if not resp.is_success:
                    logger.error("Telegram API error: %s", resp.text)
        logger.info("Telegram message sent (%d chunk(s))", len(chunks))
    except Exception as exc:
        logger.error("Telegram send failed: %s", exc)


# ---------------------------------------------------------------------------
# Daily summary
# ---------------------------------------------------------------------------

async def send_daily_summary(cfg: NotificationConfig, db: AsyncSession):
    if not cfg.daily_summary_enabled:
        return

    today = date.today().isoformat()
    subject = f"Apt Dashboard — Daily Summary — {today}"

    # Gather fleet state
    srv_result = await db.execute(select(Server))
    servers = srv_result.scalars().all()

    server_data = []
    for s in servers:
        chk_res = await db.execute(
            select(UpdateCheck)
            .where(UpdateCheck.server_id == s.id)
            .order_by(UpdateCheck.checked_at.desc())
            .limit(1)
        )
        chk = chk_res.scalar_one_or_none()
        packages = []
        if chk and chk.packages_json:
            try:
                packages = json.loads(chk.packages_json)
            except Exception:
                pass
        held = []
        if chk and chk.held_packages_list:
            try:
                held = json.loads(chk.held_packages_list)
            except Exception:
                pass
        server_data.append({
            "server": s,
            "check": chk,
            "packages": packages,
            "held": held,
        })

    html_body = _build_html_summary(subject, server_data)
    text_body = _build_text_summary(subject, server_data)
    telegram_body = _build_telegram_summary(subject, server_data)

    if cfg.email_enabled:
        await _send_email(cfg, subject, html_body, text_body)
    if cfg.telegram_enabled:
        await _send_telegram(cfg, telegram_body)


def _categorize(server_data: list[dict]):
    up_to_date, with_updates, with_errors, no_check = [], [], [], []
    for sd in server_data:
        chk = sd["check"]
        if chk is None:
            no_check.append(sd)
        elif chk.status == "error":
            with_errors.append(sd)
        elif chk.packages_available > 0:
            with_updates.append(sd)
        else:
            up_to_date.append(sd)
    return up_to_date, with_updates, with_errors, no_check


def _build_html_summary(subject: str, server_data: list[dict]) -> str:
    up_to_date, with_updates, with_errors, no_check = _categorize(server_data)
    total = len(server_data)
    reboot_servers = [sd for sd in server_data if sd["check"] and sd["check"].reboot_required]
    held_servers = [sd for sd in server_data if sd["held"]]

    rows_with_updates = ""
    for sd in with_updates:
        s, chk, pkgs = sd["server"], sd["check"], sd["packages"]
        sec_pkgs = [p for p in pkgs if p["is_security"]]
        reg_pkgs = [p for p in pkgs if not p["is_security"]]
        pkg_rows = ""
        for p in sec_pkgs:
            phased = " <em>[phased]</em>" if p["is_phased"] else ""
            pkg_rows += (
                f"<tr style='background:#1e1e2e'>"
                f"<td>🔒 <strong>{p['name']}</strong></td>"
                f"<td>{p['current_version']}</td>"
                f"<td>→ {p['available_version']}{phased}</td>"
                f"<td><em>{p['repository']}</em></td></tr>"
            )
        for p in reg_pkgs:
            phased = " <em>[phased]</em>" if p["is_phased"] else ""
            pkg_rows += (
                f"<tr>"
                f"<td>{p['name']}</td>"
                f"<td>{p['current_version']}</td>"
                f"<td>→ {p['available_version']}{phased}</td>"
                f"<td><em>{p['repository']}</em></td></tr>"
            )
        rows_with_updates += f"""
        <h3 style="color:#f59e0b">{s.name} ({s.hostname})
          — {chk.packages_available} updates
          ({chk.security_packages} security, {chk.regular_packages} regular)</h3>
        <table border="1" cellpadding="4" cellspacing="0"
               style="border-collapse:collapse;font-family:monospace;font-size:12px;width:100%">
          <tr style="background:#374151;color:#fff">
            <th>Package</th><th>Current</th><th>Available</th><th>Repo</th>
          </tr>
          {pkg_rows}
        </table>
        """

    error_rows = "".join(
        f"<li><strong>{sd['server'].name}</strong> ({sd['server'].hostname}): "
        f"{sd['check'].error_message or 'unknown error'}</li>"
        for sd in with_errors
    )
    held_rows = "".join(
        f"<li><strong>{sd['server'].name}</strong>: {', '.join(sd['held'])}</li>"
        for sd in held_servers
    )
    reboot_rows = "".join(
        f"<li>{sd['server'].name} ({sd['server'].hostname})</li>"
        for sd in reboot_servers
    )
    up_names = ", ".join(sd["server"].name for sd in up_to_date) or "none"

    return f"""<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0f1117;color:#e5e7eb;padding:20px">
<h1 style="color:#22c55e">{subject}</h1>
<p>Fleet overview: <strong>{total}</strong> servers checked —
   <span style="color:#22c55e">{len(up_to_date)} up to date</span>,
   <span style="color:#f59e0b">{len(with_updates)} with updates</span>,
   <span style="color:#ef4444">{len(with_errors)} errors</span>
</p>
{f'<h2 style="color:#f59e0b">Servers with updates</h2>{rows_with_updates}' if with_updates else ''}
{f'<h2>Servers needing reboot</h2><ul>{reboot_rows}</ul>' if reboot_servers else ''}
{f'<h2>Servers with held packages</h2><ul>{held_rows}</ul>' if held_servers else ''}
{f'<h2 style="color:#ef4444">Servers with errors</h2><ul>{error_rows}</ul>' if with_errors else ''}
<h2 style="color:#22c55e">Up to date</h2><p>{up_names}</p>
<hr><p style="color:#6b7280;font-size:12px">Generated at {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}</p>
</body></html>"""


def _build_text_summary(subject: str, server_data: list[dict]) -> str:
    up_to_date, with_updates, with_errors, _ = _categorize(server_data)
    lines = [subject, "=" * len(subject), ""]
    lines.append(f"Total: {len(server_data)} | Up to date: {len(up_to_date)} | "
                 f"Updates: {len(with_updates)} | Errors: {len(with_errors)}")
    lines.append("")
    for sd in with_updates:
        s, chk = sd["server"], sd["check"]
        lines.append(f"[UPDATES] {s.name} ({s.hostname}) — {chk.packages_available} updates "
                     f"({chk.security_packages} security)")
        for p in sd["packages"]:
            tag = "[SECURITY] " if p["is_security"] else ""
            lines.append(f"  {tag}{p['name']}: {p['current_version']} → {p['available_version']}")
    for sd in with_errors:
        lines.append(f"[ERROR] {sd['server'].name}: {sd['check'].error_message}")
    return "\n".join(lines)


def _build_telegram_summary(subject: str, server_data: list[dict]) -> str:
    up_to_date, with_updates, with_errors, _ = _categorize(server_data)
    lines = [f"*{subject}*", ""]
    lines.append(f"✅ {len(up_to_date)} up to date | "
                 f"🟡 {len(with_updates)} with updates | "
                 f"🔴 {len(with_errors)} errors")
    lines.append("")
    for sd in with_updates:
        s, chk = sd["server"], sd["check"]
        lines.append(f"*{s.name}* — {chk.packages_available} updates "
                     f"({chk.security_packages} 🔒 security)")
        for p in sd["packages"][:10]:  # cap per server to stay within limits
            tag = "🔒 " if p["is_security"] else ""
            phased = " \\[phased]" if p["is_phased"] else ""
            lines.append(f"  `{tag}{p['name']}: {p['current_version']} → {p['available_version']}{phased}`")
        if len(sd["packages"]) > 10:
            lines.append(f"  _...and {len(sd['packages']) - 10} more. See dashboard for full details._")
    for sd in with_errors:
        lines.append(f"❌ *{sd['server'].name}*: {sd['check'].error_message}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Event-driven notifications
# ---------------------------------------------------------------------------

async def notify_upgrade_complete(cfg: NotificationConfig, server: Server, history: UpdateHistory):
    if not cfg.notify_on_upgrade_complete:
        return

    pkgs = []
    if history.packages_upgraded:
        try:
            pkgs = json.loads(history.packages_upgraded)
        except Exception:
            pass

    if history.status == "success":
        subject = f"Apt Dashboard — Upgrade complete on {server.name}"
        msg = (f"Upgrade completed successfully on *{server.name}* ({server.hostname}).\n"
               f"{len(pkgs)} package(s) upgraded.")
    else:
        if not cfg.notify_on_error:
            return
        subject = f"Apt Dashboard — Upgrade FAILED on {server.name}"
        msg = (f"⚠️ Upgrade *FAILED* on *{server.name}* ({server.hostname}).\n"
               f"Check the dashboard for details.")

    html = f"<html><body><p>{msg.replace('*', '<strong>').replace('*', '</strong>')}</p></body></html>"
    await _send_email(cfg, subject, html, msg.replace("*", ""))
    await _send_telegram(cfg, msg)


async def get_telegram_updates(bot_token: str) -> list[dict]:
    """Call getUpdates to help the user find their chat_id."""
    url = TELEGRAM_API.format(token=bot_token, method="getUpdates")
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url)
        data = resp.json()
    chats = []
    for update in data.get("result", []):
        msg = update.get("message") or update.get("channel_post") or {}
        chat = msg.get("chat", {})
        if chat:
            chats.append({"id": chat.get("id"), "title": chat.get("title") or chat.get("username") or "private"})
    return chats
