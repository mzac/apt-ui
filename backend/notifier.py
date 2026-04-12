"""
Unified notification module — email (aiosmtplib) + Telegram (httpx).

Both channels are optional and controlled by notification_config in the DB.
"""

import hashlib
import hmac
import json
import logging
from datetime import datetime, date
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import aiosmtplib
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import NotificationConfig, Server, ServerStats, UpdateCheck, UpdateHistory

logger = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"
MAX_TELEGRAM_LEN = 4000  # leave buffer below 4096


# ---------------------------------------------------------------------------
# Low-level send helpers
# ---------------------------------------------------------------------------

async def _log_notification(channel: str, event_type: str, summary: str, success: bool, error: str | None = None):
    """Write a notification attempt to the notification_log table (fire-and-forget)."""
    try:
        from backend.database import AsyncSessionLocal
        from backend.models import NotificationLog
        async with AsyncSessionLocal() as db:
            entry = NotificationLog(
                channel=channel,
                event_type=event_type,
                summary=summary,
                success=success,
                error_message=error,
            )
            db.add(entry)
            await db.commit()
    except Exception as exc:
        logger.debug("_log_notification failed: %s", exc)


async def _send_email(cfg: NotificationConfig, subject: str, html_body: str, text_body: str, event_type: str = "unknown"):
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
        await _log_notification("email", event_type, subject, success=True)
    except Exception as exc:
        logger.error("Email send failed: %s", exc)
        await _log_notification("email", event_type, subject, success=False, error=str(exc))


async def _send_telegram(cfg: NotificationConfig, text: str, event_type: str = "unknown"):
    if not cfg.telegram_enabled or not cfg.telegram_bot_token or not cfg.telegram_chat_id:
        return

    url = TELEGRAM_API.format(token=cfg.telegram_bot_token, method="sendMessage")
    summary = text[:120].replace("\n", " ")

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
        await _log_notification("telegram", event_type, summary, success=True)
    except Exception as exc:
        logger.error("Telegram send failed: %s", exc)
        await _log_notification("telegram", event_type, summary, success=False, error=str(exc))


# ---------------------------------------------------------------------------
# Webhook
# ---------------------------------------------------------------------------

async def _send_webhook(cfg: NotificationConfig, event: str, payload: dict):
    """POST a JSON event to the configured webhook URL.
    If webhook_secret is set, add an X-Hub-Signature-256 header (HMAC-SHA256).
    """
    if not cfg.webhook_enabled or not cfg.webhook_url:
        return
    body = json.dumps({"event": event, **payload}).encode()
    headers = {"Content-Type": "application/json", "User-Agent": "apt-dashboard/1.0"}
    if cfg.webhook_secret:
        sig = hmac.new(cfg.webhook_secret.encode(), body, hashlib.sha256).hexdigest()
        headers["X-Hub-Signature-256"] = f"sha256={sig}"
    summary = f"{event} → {cfg.webhook_url}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(cfg.webhook_url, content=body, headers=headers)
            if not resp.is_success:
                logger.warning("Webhook %s returned %s", cfg.webhook_url, resp.status_code)
                await _log_notification("webhook", event, summary, success=False, error=f"HTTP {resp.status_code}")
            else:
                await _log_notification("webhook", event, summary, success=True)
    except Exception as exc:
        logger.error("Webhook send failed: %s", exc)
        await _log_notification("webhook", event, summary, success=False, error=str(exc))


# ---------------------------------------------------------------------------
# Daily summary
# ---------------------------------------------------------------------------

async def send_daily_summary(cfg: NotificationConfig, db: AsyncSession):
    if not cfg.daily_summary_enabled:
        return

    today = date.today().isoformat()
    subject = f"Apt Dashboard — Daily Summary — {today}"

    # Gather fleet state (reuses the shared helper; add held list per server)
    server_data = await _fetch_server_check_data(db)
    for sd in server_data:
        chk = sd["check"]
        held = []
        if chk and chk.held_packages_list:
            try:
                held = json.loads(chk.held_packages_list)
            except Exception:
                pass
        sd["held"] = held

    html_body = _build_html_summary(subject, server_data)
    text_body = _build_text_summary(subject, server_data)
    telegram_body = _build_telegram_summary(subject, server_data)

    if cfg.email_enabled and cfg.daily_summary_email:
        await _send_email(cfg, subject, html_body, text_body, event_type="daily_summary")
    if cfg.telegram_enabled and cfg.daily_summary_telegram:
        await _send_telegram(cfg, telegram_body, event_type="daily_summary")

    up_to_date, with_updates, with_errors, _ = _categorize(server_data)
    if cfg.daily_summary_webhook:
        await _send_webhook(cfg, "daily_summary", {
            "date": today,
            "total_servers": len(server_data),
            "up_to_date": len(up_to_date),
            "with_updates": len(with_updates),
            "errors": len(with_errors),
        })


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


def _build_html_summary(subject: str, server_data: list[dict]) -> str:  # noqa: C901
    up_to_date, with_updates, with_errors, no_check = _categorize(server_data)
    total = len(server_data)
    reboot_servers = [sd for sd in server_data if sd["check"] and sd["check"].reboot_required]
    eeprom_servers = [sd for sd in server_data if sd.get("stats") and sd["stats"].eeprom_update_available in ("update_available", "update_staged")]
    held_servers = [sd for sd in server_data if sd["held"]]
    today_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

    # ---------------------------------------------------------------------------
    # Fleet overview stat cards (4-up on desktop, 2-up on mobile)
    # ---------------------------------------------------------------------------
    def stat_card(value: int, label: str, color: str) -> str:
        return (
            f'<td width="25%" style="padding:4px;">'
            f'<div style="background:#ffffff;border-radius:8px;padding:14px 8px;'
            f'text-align:center;border:1px solid #e5e7eb;">'
            f'<div style="font-size:26px;font-weight:700;color:{color};'
            f'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',monospace;">{value}</div>'
            f'<div style="font-size:11px;color:#6b7280;margin-top:3px;'
            f'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;">{label}</div>'
            f'</div></td>'
        )

    overview_cards = (
        '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">'
        '<tr>'
        + stat_card(total, "Total", "#111827")
        + stat_card(len(up_to_date), "Up to date", "#16a34a")
        + stat_card(len(with_updates), "Updates", "#d97706" if with_updates else "#6b7280")
        + stat_card(len(with_errors), "Errors", "#dc2626" if with_errors else "#6b7280")
        + '</tr></table>'
    )

    # ---------------------------------------------------------------------------
    # Per-server update cards
    # ---------------------------------------------------------------------------
    def pkg_row(p: dict) -> str:
        sec = p["is_security"]
        phased = " <span style='color:#6b7280;font-size:10px;'>[phased]</span>" if p["is_phased"] else ""
        icon = "🔒&nbsp;" if sec else "&nbsp;&nbsp;&nbsp;"
        bg = "#fff7ed" if sec else "#ffffff"
        name_color = "#92400e" if sec else "#111827"
        return (
            f'<tr style="background:{bg};border-bottom:1px solid #f3f4f6;">'
            f'<td style="padding:7px 10px;font-family:\'SF Mono\',\'Fira Code\',monospace;'
            f'font-size:12px;color:{name_color};white-space:nowrap;">'
            f'{icon}<strong>{p["name"]}</strong></td>'
            f'<td style="padding:7px 10px;font-family:\'SF Mono\',\'Fira Code\',monospace;'
            f'font-size:11px;color:#6b7280;word-break:break-all;">'
            f'{p["current_version"]}</td>'
            f'<td style="padding:7px 10px;font-family:\'SF Mono\',\'Fira Code\',monospace;'
            f'font-size:11px;color:#16a34a;word-break:break-all;">'
            f'→&nbsp;{p["available_version"]}{phased}</td>'
            f'</tr>'
        )

    server_cards = ""
    for sd in with_updates:
        s, chk, pkgs = sd["server"], sd["check"], sd["packages"]
        sec_pkgs = [p for p in pkgs if p["is_security"]]
        reg_pkgs = [p for p in pkgs if not p["is_security"]]
        ordered_pkgs = sec_pkgs + reg_pkgs

        reboot_badge = (
            '<span style="background:#fef3c7;color:#92400e;font-size:10px;'
            'padding:2px 6px;border-radius:4px;margin-left:6px;">↻ reboot</span>'
            if chk.reboot_required else ""
        )

        all_pkg_rows = "".join(pkg_row(p) for p in ordered_pkgs)

        server_cards += f"""
<div style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;
            margin-bottom:12px;overflow:hidden;">
  <div style="background:#fffbeb;padding:12px 16px;border-bottom:1px solid #fde68a;">
    <div style="font-size:15px;font-weight:600;color:#92400e;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      {s.name}{reboot_badge}
    </div>
    <div style="font-size:12px;color:#6b7280;margin-top:2px;
                font-family:'SF Mono','Fira Code',monospace;">{s.hostname}</div>
    <div style="font-size:12px;color:#374151;margin-top:4px;">
      <strong>{chk.packages_available}</strong> updates
      {"&nbsp;·&nbsp;<span style='color:#dc2626;font-weight:600;'>" + str(chk.security_packages) + " security</span>" if chk.security_packages else ""}
    </div>
  </div>
  <div style="overflow-x:auto;">
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-collapse:collapse;min-width:320px;">
      <tr style="background:#f9fafb;">
        <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;
                   font-weight:600;letter-spacing:.05em;white-space:nowrap;">PACKAGE</th>
        <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;
                   font-weight:600;letter-spacing:.05em;white-space:nowrap;">CURRENT</th>
        <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;
                   font-weight:600;letter-spacing:.05em;white-space:nowrap;">AVAILABLE</th>
      </tr>
      {all_pkg_rows}
    </table>
  </div>
</div>"""

    # ---------------------------------------------------------------------------
    # Errors / held / reboot / up-to-date sections
    # ---------------------------------------------------------------------------
    error_section = ""
    if with_errors:
        items = "".join(
            f'<div style="padding:8px 12px;border-bottom:1px solid #fecaca;">'
            f'<strong style="color:#111827;">{sd["server"].name}</strong>'
            f'<span style="color:#6b7280;font-size:12px;"> ({sd["server"].hostname})</span><br>'
            f'<span style="color:#dc2626;font-size:12px;">{sd["check"].error_message or "unknown error"}</span>'
            f'</div>'
            for sd in with_errors
        )
        error_section = f"""
<div style="background:#fff;border-radius:8px;border:1px solid #fca5a5;
            margin-bottom:12px;overflow:hidden;">
  <div style="background:#fef2f2;padding:10px 16px;border-bottom:1px solid #fca5a5;">
    <span style="font-size:14px;font-weight:600;color:#dc2626;">❌ Errors</span>
  </div>
  {items}
</div>"""

    reboot_section = ""
    if reboot_servers:
        items = "".join(
            f'<div style="padding:6px 12px;border-bottom:1px solid #fde68a;'
            f'font-size:13px;color:#111827;">'
            f'<strong>{sd["server"].name}</strong> '
            f'<span style="color:#6b7280;font-size:12px;">({sd["server"].hostname})</span></div>'
            for sd in reboot_servers
        )
        reboot_section = f"""
<div style="background:#fff;border-radius:8px;border:1px solid #fde68a;
            margin-bottom:12px;overflow:hidden;">
  <div style="background:#fffbeb;padding:10px 16px;border-bottom:1px solid #fde68a;">
    <span style="font-size:14px;font-weight:600;color:#92400e;">↻ Reboot required</span>
  </div>
  {items}
</div>"""

    eeprom_section = ""
    if eeprom_servers:
        items = "".join(
            f'<div style="padding:6px 12px;border-bottom:1px solid #fde68a;'
            f'font-size:12px;color:#374151;">'
            f'<strong>{sd["server"].name}</strong>'
            f'<span style="color:#6b7280;font-size:12px;"> ({sd["server"].hostname})</span>'
            f'<span style="margin-left:8px;background:#fef3c7;color:#92400e;font-size:10px;'
            f'padding:2px 6px;border-radius:4px;">'
            f'{"staged — reboot to apply" if sd["stats"].eeprom_update_available == "update_staged" else "update available"}'
            f'</span></div>'
            for sd in eeprom_servers
        )
        eeprom_section = f"""
<div style="background:#fff;border-radius:8px;border:1px solid #fde68a;
            margin-bottom:12px;overflow:hidden;">
  <div style="background:#fffbeb;padding:10px 16px;border-bottom:1px solid #fde68a;">
    <span style="font-size:14px;font-weight:600;color:#92400e;">🔧 EEPROM firmware updates</span>
  </div>
  {items}
</div>"""

    held_section = ""
    if held_servers:
        items = "".join(
            f'<div style="padding:6px 12px;border-bottom:1px solid #bfdbfe;'
            f'font-size:12px;color:#374151;">'
            f'<strong>{sd["server"].name}:</strong> '
            f'<span style="font-family:\'SF Mono\',monospace;">{", ".join(sd["held"])}</span></div>'
            for sd in held_servers
        )
        held_section = f"""
<div style="background:#fff;border-radius:8px;border:1px solid #bfdbfe;
            margin-bottom:12px;overflow:hidden;">
  <div style="background:#eff6ff;padding:10px 16px;border-bottom:1px solid #bfdbfe;">
    <span style="font-size:14px;font-weight:600;color:#1d4ed8;">📌 Held packages</span>
  </div>
  {items}
</div>"""

    up_to_date_section = ""
    if up_to_date:
        names = "".join(
            f'<span style="display:inline-block;background:#f0fdf4;color:#166534;'
            f'border:1px solid #bbf7d0;border-radius:4px;padding:2px 8px;'
            f'font-size:12px;margin:2px;">{sd["server"].name}</span>'
            for sd in up_to_date
        )
        up_to_date_section = f"""
<div style="background:#fff;border-radius:8px;border:1px solid #bbf7d0;
            margin-bottom:12px;overflow:hidden;">
  <div style="background:#f0fdf4;padding:10px 16px;border-bottom:1px solid #bbf7d0;">
    <span style="font-size:14px;font-weight:600;color:#166534;">✓ Up to date</span>
  </div>
  <div style="padding:10px 12px;">{names}</div>
</div>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>{subject}</title>
  <style>
    @media only screen and (max-width:480px) {{
      .wrap {{ padding:10px !important; }}
    }}
  </style>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div class="wrap" style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="background:#1a1f2e;border-radius:8px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:11px;color:#4ade80;letter-spacing:.1em;
                font-weight:600;text-transform:uppercase;margin-bottom:4px;">APT DASHBOARD</div>
    <div style="font-size:20px;font-weight:700;color:#f9fafb;">Daily Summary</div>
    <div style="font-size:12px;color:#9ca3af;margin-top:4px;">{today_str}</div>
  </div>

  <!-- Fleet overview -->
  {overview_cards}

  <!-- Servers with updates -->
  {"".join(['<div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:8px;padding-left:2px;">🟡 Servers with updates</div>', server_cards]) if with_updates else ""}

  {error_section}
  {reboot_section}
  {eeprom_section}
  {held_section}
  {up_to_date_section}

  <!-- Footer -->
  <div style="text-align:center;padding:16px 0 0;
              font-size:11px;color:#9ca3af;">
    Apt Dashboard · {today_str}
  </div>

</div>
</body>
</html>"""


def _build_text_summary(subject: str, server_data: list[dict]) -> str:
    up_to_date, with_updates, with_errors, _ = _categorize(server_data)
    reboot_servers = [sd for sd in server_data if sd["check"] and sd["check"].reboot_required]
    eeprom_servers = [sd for sd in server_data if sd.get("stats") and sd["stats"].eeprom_update_available in ("update_available", "update_staged")]
    lines = [subject, "=" * len(subject), ""]
    lines.append(f"Total: {len(server_data)} | Up to date: {len(up_to_date)} | "
                 f"Updates: {len(with_updates)} | Errors: {len(with_errors)}")
    if reboot_servers:
        lines.append(f"Reboot required: {', '.join(sd['server'].name for sd in reboot_servers)}")
    if eeprom_servers:
        lines.append(f"EEPROM updates: {', '.join(sd['server'].name for sd in eeprom_servers)}")
    lines.append("")
    for sd in with_updates:
        s, chk = sd["server"], sd["check"]
        reboot_flag = " [REBOOT REQUIRED]" if chk.reboot_required else ""
        lines.append(f"[UPDATES] {s.name} ({s.hostname}) — {chk.packages_available} updates "
                     f"({chk.security_packages} security){reboot_flag}")
        for p in sd["packages"]:
            tag = "[SECURITY] " if p["is_security"] else ""
            lines.append(f"  {tag}{p['name']}: {p['current_version']} → {p['available_version']}")
    for sd in with_errors:
        lines.append(f"[ERROR] {sd['server'].name}: {sd['check'].error_message}")
    return "\n".join(lines)


def _build_telegram_summary(subject: str, server_data: list[dict]) -> str:
    up_to_date, with_updates, with_errors, _ = _categorize(server_data)
    reboot_servers = [sd for sd in server_data if sd["check"] and sd["check"].reboot_required]
    eeprom_servers = [sd for sd in server_data if sd.get("stats") and sd["stats"].eeprom_update_available in ("update_available", "update_staged")]
    lines = [f"*{subject}*", ""]
    lines.append(f"✅ {len(up_to_date)} up to date | "
                 f"🟡 {len(with_updates)} with updates | "
                 f"🔴 {len(with_errors)} errors")
    if reboot_servers:
        lines.append(f"↻ Reboot required: {', '.join('*' + sd['server'].name + '*' for sd in reboot_servers)}")
    if eeprom_servers:
        lines.append(f"🔧 EEPROM updates: {', '.join('*' + sd['server'].name + '*' for sd in eeprom_servers)}")
    lines.append("")
    for sd in with_updates:
        s, chk = sd["server"], sd["check"]
        reboot_flag = " ↻" if chk.reboot_required else ""
        lines.append(f"*{s.name}*{reboot_flag} — {chk.packages_available} updates "
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

def _pkg_label(p) -> str:
    """Return a human-readable package label with version transition if available."""
    if isinstance(p, dict):
        name = p.get("name", str(p))
        frm = p.get("from_version", "")
        to = p.get("to_version", "")
        if frm and to:
            return f"{name}: {frm} → {to}"
        return name
    return str(p)


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
        action_label = history.action or "upgrade"
        date_str = (history.completed_at or history.started_at).strftime("%Y-%m-%d %H:%M UTC")

        pkg_lines = [_pkg_label(p) for p in pkgs]
        pkg_list_text = "\n".join(f"  • {l}" for l in pkg_lines) if pkg_lines else "  (none)"
        text = (
            f"Upgrade completed on {server.name} ({server.hostname})\n"
            f"Action: {action_label} | {len(pkgs)} package(s) | {date_str}\n\n"
            f"Packages upgraded:\n{pkg_list_text}"
        )

        def _pkg_row(p):
            if isinstance(p, dict) and p.get("from_version") and p.get("to_version"):
                return (
                    f"<tr>"
                    f"<td style='padding:3px 8px 3px 0;font-family:monospace;white-space:nowrap'>{p['name']}</td>"
                    f"<td style='padding:3px 8px;color:#888;font-family:monospace;white-space:nowrap'>{p['from_version']}</td>"
                    f"<td style='padding:3px 4px;color:#888'>→</td>"
                    f"<td style='padding:3px 0 3px 4px;font-family:monospace;white-space:nowrap;color:#22c55e'>{p['to_version']}</td>"
                    f"</tr>"
                )
            name = p.get("name", str(p)) if isinstance(p, dict) else str(p)
            return f"<tr><td style='padding:3px 8px 3px 0;font-family:monospace'>{name}</td></tr>"

        pkg_rows = "".join(_pkg_row(p) for p in pkgs)
        pkg_table = (
            "<table border='0' cellpadding='0' style='border-collapse:collapse;margin-top:8px'>"
            + pkg_rows + "</table>"
        ) if pkgs else "<p style='color:#888;font-size:13px'>(no packages listed)</p>"

        html = f"""<html><body style='font-family:sans-serif;background:#0f1117;color:#e2e8f0'>
<div style='max-width:600px;margin:20px auto;background:#1a1d27;border-radius:8px;padding:24px'>
  <h2 style='margin:0 0 4px 0;color:#22c55e'>✓ Upgrade complete</h2>
  <p style='margin:0 0 16px 0;color:#94a3b8'>{server.name} ({server.hostname}) — {date_str}</p>
  <p style='margin:0 0 8px 0;color:#94a3b8'>Action: <strong style='color:#e2e8f0'>{action_label}</strong>
     &nbsp;|&nbsp; <strong style='color:#e2e8f0'>{len(pkgs)}</strong> package(s) upgraded</p>
  <hr style='border:none;border-top:1px solid #2d3748;margin:16px 0'>
  <h3 style='margin:0 0 8px 0;font-size:14px;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em'>Packages upgraded</h3>
  {pkg_table}
</div>
</body></html>"""
    else:
        if not cfg.notify_on_error:
            return
        subject = f"Apt Dashboard — Upgrade FAILED on {server.name}"
        text = f"Upgrade FAILED on {server.name} ({server.hostname}). Check the dashboard for details."
        html = (
            "<html><body style='font-family:sans-serif;background:#0f1117;color:#e2e8f0'>"
            "<div style='max-width:600px;margin:20px auto;background:#1a1d27;border-radius:8px;padding:24px'>"
            f"<h2 style='color:#ef4444'>✗ Upgrade failed</h2>"
            f"<p style='color:#94a3b8'><strong style='color:#e2e8f0'>{server.name}</strong> ({server.hostname})</p>"
            "<p style='color:#94a3b8'>Check the dashboard for details and log output.</p>"
            "</div></body></html>"
        )

    is_success = history.status == "success"
    evt = "upgrade_complete" if is_success else "upgrade_error"
    if cfg.notify_upgrade_email if is_success else cfg.notify_error_email:
        await _send_email(cfg, subject, html, text, event_type=evt)
    if cfg.notify_upgrade_telegram if is_success else cfg.notify_error_telegram:
        await _send_telegram(cfg, text, event_type=evt)
    webhook_allowed = cfg.notify_upgrade_webhook if is_success else cfg.notify_error_webhook
    if webhook_allowed:
        event = "upgrade_complete" if is_success else "upgrade_failed"
        await _send_webhook(cfg, event, {
            "server": server.name, "hostname": server.hostname,
            "action": history.action, "status": history.status,
            "packages_upgraded": len(pkgs),
        })


async def notify_upgrade_all_complete(cfg: NotificationConfig, results: list):
    """Send one summary notification after an upgrade-all batch."""
    if not cfg.notify_on_upgrade_complete:
        return

    successes = [(s, h) for s, h in results if h.status == "success"]
    failures = [(s, h) for s, h in results if h.status != "success"]

    subject = f"Apt Dashboard — Upgrade All complete ({len(successes)} ok, {len(failures)} failed)"

    lines = [f"Upgrade-all finished: {len(results)} server(s) processed.\n"]
    if successes:
        lines.append("✓ Succeeded:")
        for s, h in successes:
            try:
                pkgs = json.loads(h.packages_upgraded or "[]")
            except Exception:
                pkgs = []
            lines.append(f"  • {s.name} — {len(pkgs)} package(s) upgraded")
            for p in pkgs:
                lines.append(f"      {_pkg_label(p)}")
    if failures:
        lines.append("\n✗ Failed:")
        for s, h in failures:
            lines.append(f"  • {s.name} — {h.status}")

    text = "\n".join(lines)
    html = "<html><body><pre style='font-family:monospace'>" + text + "</pre></body></html>"
    if cfg.notify_upgrade_email:
        await _send_email(cfg, subject, html, text, event_type="upgrade_all_complete")
    if cfg.notify_upgrade_telegram:
        await _send_telegram(cfg, text, event_type="upgrade_all_complete")
    if cfg.notify_upgrade_webhook:
        await _send_webhook(cfg, "upgrade_all_complete", {
            "total": len(results),
            "succeeded": len(successes),
            "failed": len(failures),
            "servers": [{"server": s.name, "hostname": s.hostname, "status": h.status} for s, h in results],
        })


async def _fetch_server_check_data(db: AsyncSession) -> list[dict]:
    """Fetch all servers with their latest check and stats rows."""
    srv_result = await db.execute(select(Server))
    servers = srv_result.scalars().all()
    rows = []
    for s in servers:
        chk_res = await db.execute(
            select(UpdateCheck)
            .where(UpdateCheck.server_id == s.id)
            .order_by(UpdateCheck.checked_at.desc())
            .limit(1)
        )
        chk = chk_res.scalar_one_or_none()
        stats_res = await db.execute(
            select(ServerStats)
            .where(ServerStats.server_id == s.id)
            .order_by(ServerStats.recorded_at.desc())
            .limit(1)
        )
        stats = stats_res.scalar_one_or_none()
        packages = []
        if chk and chk.packages_json:
            try:
                packages = json.loads(chk.packages_json)
            except Exception:
                pass
        rows.append({"server": s, "check": chk, "stats": stats, "packages": packages})
    return rows


async def notify_security_updates_found(cfg: NotificationConfig, db: AsyncSession):
    """Fire after a check-all when any server has pending security updates."""
    if not cfg.notify_security_updates:
        return

    server_data = await _fetch_server_check_data(db)
    sec_servers = [
        sd for sd in server_data
        if sd["check"] and sd["check"].status == "success" and sd["check"].security_packages > 0
    ]
    if not sec_servers:
        return

    total_sec = sum(sd["check"].security_packages for sd in sec_servers)
    subject = f"Apt Dashboard — {total_sec} Security Update(s) on {len(sec_servers)} Server(s)"

    # Plain text
    lines = [subject, ""]
    for sd in sec_servers:
        s, chk = sd["server"], sd["check"]
        lines.append(f"{s.name} ({s.hostname}) — {chk.security_packages} security update(s)")
        for p in [p for p in sd["packages"] if p.get("is_security")]:
            lines.append(f"  🔒 {p['name']}: {p['current_version']} → {p['available_version']}")
    text = "\n".join(lines)

    # HTML
    rows_html = ""
    for sd in sec_servers:
        s, chk = sd["server"], sd["check"]
        sec_pkgs = [p for p in sd["packages"] if p.get("is_security")]
        pkg_rows = "".join(
            f"<tr><td style='padding:3px 12px 3px 0;font-family:monospace;font-size:12px'>"
            f"🔒 <strong>{p['name']}</strong></td>"
            f"<td style='padding:3px 8px;font-family:monospace;font-size:11px;color:#888'>{p['current_version']}</td>"
            f"<td style='padding:3px 4px;color:#888'>→</td>"
            f"<td style='padding:3px 0;font-family:monospace;font-size:11px;color:#dc2626'>{p['available_version']}</td></tr>"
            for p in sec_pkgs
        )
        rows_html += (
            f"<div style='margin-bottom:12px;background:#fff;border:1px solid #fca5a5;"
            f"border-radius:8px;overflow:hidden;'>"
            f"<div style='background:#fef2f2;padding:10px 16px;border-bottom:1px solid #fca5a5;'>"
            f"<strong style='color:#111'>{s.name}</strong>"
            f"<span style='color:#6b7280;font-size:12px;margin-left:8px'>{s.hostname}</span>"
            f"<span style='margin-left:8px;font-size:12px;color:#dc2626;font-weight:600'>"
            f"{chk.security_packages} security update(s)</span></div>"
            f"<div style='padding:8px 16px'><table border='0' cellpadding='0'>{pkg_rows}</table></div>"
            f"</div>"
        )
    html = (
        f"<html><body style='font-family:sans-serif;background:#f4f4f5'>"
        f"<div style='max-width:600px;margin:20px auto;'>"
        f"<div style='background:#1a1f2e;border-radius:8px;padding:20px 24px;margin-bottom:16px'>"
        f"<div style='font-size:11px;color:#f87171;letter-spacing:.1em;font-weight:600;text-transform:uppercase'>SECURITY ALERT</div>"
        f"<div style='font-size:18px;font-weight:700;color:#f9fafb;margin-top:4px'>{subject}</div>"
        f"</div>{rows_html}</div></body></html>"
    )

    # Telegram
    tg_lines = [f"🔒 *Security Updates Found*", ""]
    for sd in sec_servers:
        s, chk = sd["server"], sd["check"]
        tg_lines.append(f"*{s.name}* — {chk.security_packages} security update(s)")
        for p in [p for p in sd["packages"] if p.get("is_security")][:5]:
            tg_lines.append(f"  `{p['name']}: {p['current_version']} → {p['available_version']}`")
    tg_text = "\n".join(tg_lines)

    if cfg.notify_security_email:
        await _send_email(cfg, subject, html, text, event_type="security_updates_found")
    if cfg.notify_security_telegram:
        await _send_telegram(cfg, tg_text, event_type="security_updates_found")
    if cfg.notify_security_webhook:
        await _send_webhook(cfg, "security_updates_found", {
            "total_security_updates": total_sec,
            "servers": [
                {"server": sd["server"].name, "hostname": sd["server"].hostname,
                 "security_packages": sd["check"].security_packages}
                for sd in sec_servers
            ],
        })


async def notify_reboot_required(cfg: NotificationConfig, db: AsyncSession):
    """Fire after a check-all when any server needs a reboot."""
    if not cfg.notify_reboot_required:
        return

    server_data = await _fetch_server_check_data(db)
    reboot_servers = [
        sd for sd in server_data
        if sd["check"] and sd["check"].status == "success" and sd["check"].reboot_required
    ]
    if not reboot_servers:
        return

    subject = f"Apt Dashboard — Reboot Required on {len(reboot_servers)} Server(s)"

    lines = [subject, ""]
    for sd in reboot_servers:
        s = sd["server"]
        lines.append(f"↻ {s.name} ({s.hostname})")
    text = "\n".join(lines)

    server_items = "".join(
        f"<div style='padding:8px 12px;border-bottom:1px solid #fde68a;font-size:13px'>"
        f"<strong style='color:#111'>{sd['server'].name}</strong>"
        f"<span style='color:#6b7280;font-size:12px;margin-left:8px'>{sd['server'].hostname}</span>"
        f"</div>"
        for sd in reboot_servers
    )
    html = (
        f"<html><body style='font-family:sans-serif;background:#f4f4f5'>"
        f"<div style='max-width:600px;margin:20px auto;'>"
        f"<div style='background:#1a1f2e;border-radius:8px;padding:20px 24px;margin-bottom:16px'>"
        f"<div style='font-size:11px;color:#fbbf24;letter-spacing:.1em;font-weight:600;text-transform:uppercase'>REBOOT REQUIRED</div>"
        f"<div style='font-size:18px;font-weight:700;color:#f9fafb;margin-top:4px'>{subject}</div>"
        f"</div>"
        f"<div style='background:#fff;border:1px solid #fde68a;border-radius:8px;overflow:hidden'>"
        f"<div style='background:#fffbeb;padding:10px 16px;border-bottom:1px solid #fde68a'>"
        f"<span style='font-weight:600;color:#92400e'>↻ Servers requiring reboot</span></div>"
        f"{server_items}</div></div></body></html>"
    )

    tg_text = (
        f"↻ *Reboot Required*\n\n"
        + "\n".join(f"• *{sd['server'].name}* ({sd['server'].hostname})" for sd in reboot_servers)
    )

    if cfg.notify_reboot_email:
        await _send_email(cfg, subject, html, text, event_type="reboot_required")
    if cfg.notify_reboot_telegram:
        await _send_telegram(cfg, tg_text, event_type="reboot_required")
    if cfg.notify_reboot_webhook:
        await _send_webhook(cfg, "reboot_required", {
            "servers": [
                {"server": sd["server"].name, "hostname": sd["server"].hostname}
                for sd in reboot_servers
            ],
        })


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
