"""
Unified notification module — email (aiosmtplib) + Telegram (httpx) + Slack (httpx) + webhook.

All channels are optional and controlled by notification_config in the DB.
"""

import hashlib
import hmac
import json
import logging
from datetime import datetime, date, timedelta
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
    msg["From"] = cfg.email_from or cfg.smtp_username or "apt-ui@localhost"
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

    failed_chunks: list[str] = []
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
                    failed_chunks.append(f"HTTP {resp.status_code}")
        logger.info("Telegram message sent (%d chunk(s), %d failed)", len(chunks), len(failed_chunks))
        if failed_chunks:
            await _log_notification(
                "telegram", event_type, summary,
                success=False,
                error=f"{len(failed_chunks)}/{len(chunks)} chunk(s) rejected: {failed_chunks[0]}",
            )
        else:
            await _log_notification("telegram", event_type, summary, success=True)
    except Exception as exc:
        logger.error("Telegram send failed: %s", exc)
        await _log_notification("telegram", event_type, summary, success=False, error=str(exc))


# ---------------------------------------------------------------------------
# Slack (incoming webhook + Block Kit)
# ---------------------------------------------------------------------------

# Slack rejects messages > 40k chars; section block text limited to 3000.
# We chunk long code-fence bodies to stay within those limits.
MAX_SLACK_TEXT_LEN = 2900


def _slack_blocks(header: str, body: str | None = None, code_body: str | None = None) -> list[dict]:
    """Build a minimal Block Kit payload — header + section text and/or code-fenced section.

    The plain `body` is rendered as Slack mrkdwn; `code_body` is wrapped in a triple-backtick
    fence and used for command output / package lists. Both are optional.
    """
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": header[:150], "emoji": True}}
    ]
    if body:
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": body[:2900]},
        })
    if code_body:
        # Truncate to fit Slack's per-block limit. Leave space for the fence and ellipsis.
        truncated = code_body
        if len(truncated) > MAX_SLACK_TEXT_LEN:
            truncated = truncated[:MAX_SLACK_TEXT_LEN] + "\n…(truncated)"
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"```{truncated}```"},
        })
    return blocks


async def _send_slack(
    cfg: NotificationConfig,
    header: str,
    body: str | None = None,
    code_body: str | None = None,
    event_type: str = "unknown",
):
    """POST a Block Kit message to the configured Slack incoming-webhook URL."""
    if not cfg.slack_enabled or not cfg.slack_webhook_url:
        return

    payload: dict = {
        "blocks": _slack_blocks(header, body=body, code_body=code_body),
        # `text` is a fallback for notification previews / older clients.
        "text": header,
    }
    if cfg.slack_channel:
        payload["channel"] = cfg.slack_channel

    summary = header[:120].replace("\n", " ")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(cfg.slack_webhook_url, json=payload)
            if not resp.is_success:
                logger.error("Slack webhook returned %s: %s", resp.status_code, resp.text[:200])
                await _log_notification(
                    "slack", event_type, summary,
                    success=False,
                    error=f"HTTP {resp.status_code}: {resp.text[:200]}",
                )
                return
        logger.info("Slack message sent: %s", summary)
        await _log_notification("slack", event_type, summary, success=True)
    except Exception as exc:
        logger.error("Slack send failed: %s", exc)
        await _log_notification("slack", event_type, summary, success=False, error=str(exc))


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
    headers = {"Content-Type": "application/json", "User-Agent": "apt-ui/1.0"}
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

    # Use the configured TZ for both subject date and body timestamp so they
    # don't drift around midnight UTC (e.g. subject shows Mar 5 while body shows Mar 4).
    from backend.config import TZ
    now_local = datetime.now(tz=TZ)
    today = now_local.date().isoformat()
    today_str = now_local.strftime("%Y-%m-%d %H:%M %Z")
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

    html_body = _build_html_summary(subject, server_data, today_str)
    text_body = _build_text_summary(subject, server_data)
    telegram_body = _build_telegram_summary(subject, server_data)
    slack_summary, slack_details = _build_slack_summary(server_data)

    if cfg.email_enabled and cfg.daily_summary_email:
        await _send_email(cfg, subject, html_body, text_body, event_type="daily_summary")
    if cfg.telegram_enabled and cfg.daily_summary_telegram:
        await _send_telegram(cfg, telegram_body, event_type="daily_summary")
    if cfg.slack_enabled and cfg.daily_summary_slack:
        await _send_slack(
            cfg,
            header=f"Apt Dashboard — Daily Summary ({today})",
            body=slack_summary,
            code_body=slack_details if slack_details else None,
            event_type="daily_summary",
        )

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


def _build_html_summary(subject: str, server_data: list[dict], today_str: str | None = None) -> str:  # noqa: C901
    up_to_date, with_updates, with_errors, no_check = _categorize(server_data)
    total = len(server_data)
    reboot_servers = [sd for sd in server_data if sd["check"] and sd["check"].reboot_required]
    eeprom_servers = [sd for sd in server_data if sd.get("stats") and sd["stats"].eeprom_update_available in ("update_available", "update_staged")]
    held_servers = [sd for sd in server_data if sd["held"]]
    if today_str is None:
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


def _build_slack_summary(server_data: list[dict]) -> tuple[str, str]:
    """Build (mrkdwn body, code-fenced details) for the Slack daily summary."""
    up_to_date, with_updates, with_errors, _ = _categorize(server_data)
    reboot_servers = [sd for sd in server_data if sd["check"] and sd["check"].reboot_required]
    eeprom_servers = [
        sd for sd in server_data
        if sd.get("stats") and sd["stats"].eeprom_update_available in ("update_available", "update_staged")
    ]

    summary_lines = [
        f"*Total:* {len(server_data)}  ·  "
        f"*Up to date:* {len(up_to_date)}  ·  "
        f"*With updates:* {len(with_updates)}  ·  "
        f"*Errors:* {len(with_errors)}"
    ]
    if reboot_servers:
        summary_lines.append(
            "↻ *Reboot required:* " + ", ".join(sd["server"].name for sd in reboot_servers)
        )
    if eeprom_servers:
        summary_lines.append(
            "🔧 *EEPROM updates:* " + ", ".join(sd["server"].name for sd in eeprom_servers)
        )

    detail_lines: list[str] = []
    for sd in with_updates:
        s, chk = sd["server"], sd["check"]
        reboot_flag = " [REBOOT]" if chk.reboot_required else ""
        detail_lines.append(
            f"{s.name} ({s.hostname}) — {chk.packages_available} updates "
            f"({chk.security_packages} security){reboot_flag}"
        )
        for p in sd["packages"][:8]:
            tag = "[SEC] " if p.get("is_security") else ""
            detail_lines.append(
                f"  {tag}{p['name']}: {p['current_version']} → {p['available_version']}"
            )
        if len(sd["packages"]) > 8:
            detail_lines.append(f"  …and {len(sd['packages']) - 8} more")
    for sd in with_errors:
        detail_lines.append(
            f"[ERROR] {sd['server'].name}: {sd['check'].error_message or 'unknown error'}"
        )
    return "\n".join(summary_lines), "\n".join(detail_lines)


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
    slack_allowed = cfg.notify_upgrade_slack if is_success else cfg.notify_error_slack
    if slack_allowed:
        if is_success:
            slack_header = f"✓ Upgrade complete on {server.name}"
            slack_body = (
                f"*Host:* `{server.hostname}`  ·  "
                f"*Action:* `{history.action or 'upgrade'}`  ·  "
                f"*Packages:* {len(pkgs)}"
            )
            slack_code = "\n".join(_pkg_label(p) for p in pkgs) if pkgs else None
        else:
            slack_header = f"✗ Upgrade FAILED on {server.name}"
            slack_body = f"*Host:* `{server.hostname}` — check the dashboard for details."
            slack_code = None
        await _send_slack(cfg, slack_header, body=slack_body, code_body=slack_code, event_type=evt)
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
    if cfg.notify_upgrade_slack:
        slack_header = f"Upgrade-all complete — {len(successes)} ok, {len(failures)} failed"
        slack_body = (
            f"*Total processed:* {len(results)}  ·  "
            f"*Succeeded:* {len(successes)}  ·  "
            f"*Failed:* {len(failures)}"
        )
        await _send_slack(
            cfg,
            slack_header,
            body=slack_body,
            code_body=text if text else None,
            event_type="upgrade_all_complete",
        )
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
    if cfg.notify_security_slack:
        slack_header = f"🔒 Security Updates — {total_sec} on {len(sec_servers)} server(s)"
        slack_body_lines = []
        slack_code_lines = []
        for sd in sec_servers:
            s, chk = sd["server"], sd["check"]
            slack_body_lines.append(f"• *{s.name}* (`{s.hostname}`) — {chk.security_packages} security update(s)")
            for p in [pp for pp in sd["packages"] if pp.get("is_security")][:5]:
                slack_code_lines.append(
                    f"{s.name}: {p['name']} {p['current_version']} → {p['available_version']}"
                )
        await _send_slack(
            cfg,
            slack_header,
            body="\n".join(slack_body_lines),
            code_body="\n".join(slack_code_lines) if slack_code_lines else None,
            event_type="security_updates_found",
        )
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
    if cfg.notify_reboot_slack:
        slack_header = f"↻ Reboot Required — {len(reboot_servers)} server(s)"
        slack_body = "\n".join(
            f"• *{sd['server'].name}* (`{sd['server'].hostname}`)" for sd in reboot_servers
        )
        await _send_slack(cfg, slack_header, body=slack_body, event_type="reboot_required")
    if cfg.notify_reboot_webhook:
        await _send_webhook(cfg, "reboot_required", {
            "servers": [
                {"server": sd["server"].name, "hostname": sd["server"].hostname}
                for sd in reboot_servers
            ],
        })


# ---------------------------------------------------------------------------
# Weekly patch digest (issue #58)
# ---------------------------------------------------------------------------

async def compose_weekly_digest(db: AsyncSession) -> dict:
    """Aggregate fleet activity over the last 7 days into a digest payload.

    Returns a dict with the structured data plus pre-rendered email/Telegram
    bodies. The dict is also the shape sent to the webhook.
    """
    from backend.config import TZ
    from backend.eol_data import get_eol_status_from_os_info

    now_local = datetime.now(tz=TZ)
    week_ago_local = now_local - timedelta(days=7)
    # The DB stores naive UTC; compare against the UTC-equivalent cutoff.
    week_ago_utc_naive = (now_local.astimezone(tz=None) - timedelta(days=7)).replace(tzinfo=None)
    now_utc_naive = datetime.utcnow()

    # Headline counters from update_history (last 7d)
    hist_res = await db.execute(
        select(UpdateHistory).where(UpdateHistory.started_at >= week_ago_utc_naive)
    )
    history_rows = list(hist_res.scalars().all())

    total_pkgs_upgraded = 0
    security_pkgs_upgraded = 0
    servers_upgraded_ids: set[int] = set()
    per_server_counts: dict[int, dict] = {}  # server_id -> {runs, pkgs, last_run}

    for h in history_rows:
        if h.status != "success":
            continue
        try:
            pkgs = json.loads(h.packages_upgraded) if h.packages_upgraded else []
        except Exception:
            pkgs = []
        n = len(pkgs)
        # We don't have per-package security flags in update_history, so we use
        # an approximate name-based heuristic for the security counter.
        for p in pkgs:
            name = p.get("name") if isinstance(p, dict) else str(p)
            if isinstance(name, str) and any(tok in name for tok in ("-security", "linux-image", "openssl", "openssh")):
                security_pkgs_upgraded += 1
        total_pkgs_upgraded += n
        servers_upgraded_ids.add(h.server_id)
        s = per_server_counts.setdefault(h.server_id, {"runs": 0, "pkgs": 0, "last_run": None})
        s["runs"] += 1
        s["pkgs"] += n
        ts = h.completed_at or h.started_at
        if s["last_run"] is None or (ts and ts > s["last_run"]):
            s["last_run"] = ts

    # Current fleet state — still pending updates / health flags
    server_data = await _fetch_server_check_data(db)
    pending: list[dict] = []
    offline_24h: list[dict] = []
    boot_alerts: list[dict] = []
    kernel_old: list[dict] = []
    eol_soon: list[dict] = []

    for sd in server_data:
        s, chk, stats = sd["server"], sd["check"], sd.get("stats")
        # Pending list
        if chk and chk.status == "success" and chk.packages_available > 0:
            pending.append({
                "server": s.name,
                "hostname": s.hostname,
                "packages_available": chk.packages_available,
                "security_packages": chk.security_packages,
                "reboot_required": bool(chk.reboot_required),
                "kept_back": False,  # we don't surface kept_back in stored check
                "checked_at": chk.checked_at.isoformat() if chk.checked_at else None,
            })
        # Offline > 24h
        if not s.is_reachable and (s.last_seen is None or (now_utc_naive - s.last_seen) > timedelta(hours=24)):
            offline_24h.append({"server": s.name, "hostname": s.hostname, "last_seen": s.last_seen.isoformat() if s.last_seen else None})
        # /boot disk-space alert (<10%, but only if total is known)
        if stats and stats.boot_total_mb and stats.boot_free_mb is not None:
            if stats.boot_total_mb > 0 and (stats.boot_free_mb / stats.boot_total_mb) < 0.10:
                boot_alerts.append({
                    "server": s.name,
                    "hostname": s.hostname,
                    "boot_free_mb": stats.boot_free_mb,
                    "boot_total_mb": stats.boot_total_mb,
                })
        # Kernel age > 180d
        if stats and stats.kernel_install_date:
            age_days = (now_utc_naive - stats.kernel_install_date).total_seconds() / 86400
            if age_days > 180:
                kernel_old.append({
                    "server": s.name,
                    "hostname": s.hostname,
                    "kernel_age_days": int(age_days),
                    "kernel_version": stats.kernel_version or "",
                })
        # OS EOL within 90 days
        if s.os_info:
            try:
                eol = get_eol_status_from_os_info(s.os_info)
                if eol and eol.get("days_remaining") is not None and eol["days_remaining"] <= 90:
                    eol_soon.append({
                        "server": s.name,
                        "hostname": s.hostname,
                        "os_info": s.os_info,
                        "eol_date": eol.get("date"),
                        "days_remaining": eol["days_remaining"],
                    })
            except Exception:
                pass

    # Sort pending oldest-checked first
    pending.sort(key=lambda r: r["checked_at"] or "")

    # By-server table for the email
    by_server: list[dict] = []
    server_lookup = {sd["server"].id: sd for sd in server_data}
    for sid, info in per_server_counts.items():
        sd = server_lookup.get(sid)
        if not sd:
            continue
        s, chk = sd["server"], sd["check"]
        status = "ok"
        if chk is None or chk.status != "success":
            status = "error" if chk and chk.status == "error" else "no-check"
        elif chk.packages_available > 0:
            status = "pending"
        by_server.append({
            "server": s.name,
            "hostname": s.hostname,
            "runs": info["runs"],
            "packages": info["pkgs"],
            "last_run": info["last_run"].isoformat() if info["last_run"] else None,
            "last_check": chk.checked_at.isoformat() if chk and chk.checked_at else None,
            "status": status,
        })
    by_server.sort(key=lambda r: r["packages"], reverse=True)

    # CVE summary — count CVEs whose USN published in the last 7d
    new_cves_by_severity: dict[str, int] = {"critical": 0, "high": 0, "medium": 0, "low": 0, "unknown": 0}
    new_cve_pkgs: set[str] = set()
    affected_servers_for_new_cves = 0
    try:
        from backend.cve_matcher import _load_cache  # type: ignore
        cache = _load_cache() or {}
        index = cache.get("index", {}) if isinstance(cache, dict) else {}
        cutoff_iso = week_ago_utc_naive.isoformat()
        # Set of (severity) per package with new USN in window
        recent_pkgs: set[str] = set()
        for pkg, entries in index.items():
            for e in entries:
                pub = e.get("published") or ""
                if pub and pub >= cutoff_iso:
                    recent_pkgs.add(pkg)
                    sev = (e.get("severity") or "unknown").lower()
                    if sev not in new_cves_by_severity:
                        sev = "unknown"
                    new_cves_by_severity[sev] += 1
        new_cve_pkgs = recent_pkgs
        # How many servers have *any* pending package matching a recent USN package
        for sd in server_data:
            chk = sd["check"]
            if not chk or not chk.packages_json:
                continue
            try:
                pkgs = json.loads(chk.packages_json)
            except Exception:
                continue
            names = {p.get("name") for p in pkgs if isinstance(p, dict)}
            if names & recent_pkgs:
                affected_servers_for_new_cves += 1
    except Exception as exc:
        logger.debug("Weekly digest: CVE summary skipped: %s", exc)

    date_range = f"{week_ago_local.date().isoformat()} → {now_local.date().isoformat()}"

    headline = {
        "packages_upgraded": total_pkgs_upgraded,
        "security_packages_upgraded": security_pkgs_upgraded,
        "servers_upgraded": len(servers_upgraded_ids),
        "servers_pending": len(pending),
        "new_cves": sum(new_cves_by_severity.values()),
        "new_cve_packages": len(new_cve_pkgs),
        "affected_servers_for_new_cves": affected_servers_for_new_cves,
    }

    health = {
        "offline_24h": offline_24h,
        "boot_disk_alerts": boot_alerts,
        "kernel_age_180d": kernel_old,
        "eol_within_90d": eol_soon,
    }

    cve_summary = {
        "by_severity": new_cves_by_severity,
        "package_count": len(new_cve_pkgs),
        "affected_servers": affected_servers_for_new_cves,
    }

    payload = {
        "event": "weekly_digest",
        "date_range": date_range,
        "generated_at": now_local.isoformat(),
        "headline": headline,
        "by_server": by_server,
        "pending": pending,
        "cve_summary": cve_summary,
        "health": health,
    }

    subject = (
        f"apt-ui digest — {date_range}: "
        f"{total_pkgs_upgraded} packages upgraded across {len(servers_upgraded_ids)} servers"
    )
    payload["subject"] = subject
    payload["html_body"] = _build_weekly_html(subject, payload)
    payload["text_body"] = _build_weekly_text(subject, payload)
    payload["telegram_body"] = _build_weekly_telegram(subject, payload)

    return payload


def _build_weekly_text(subject: str, p: dict) -> str:
    h = p["headline"]
    lines = [subject, "=" * len(subject), ""]
    lines.append(
        f"Packages upgraded: {h['packages_upgraded']} "
        f"({h['security_packages_upgraded']} security-flagged) "
        f"on {h['servers_upgraded']} server(s)"
    )
    lines.append(f"Servers still pending updates: {h['servers_pending']}")
    lines.append(
        f"New CVEs this week: {h['new_cves']} "
        f"across {h['new_cve_packages']} package(s); "
        f"{h['affected_servers_for_new_cves']} server(s) affected"
    )
    lines.append("")
    if p["by_server"]:
        lines.append("By server (last 7d upgrades):")
        for r in p["by_server"]:
            lines.append(
                f"  {r['server']:<24} runs={r['runs']:<3} pkgs={r['packages']:<4} "
                f"status={r['status']}"
            )
        lines.append("")
    if p["pending"]:
        lines.append("Still pending:")
        for r in p["pending"][:30]:
            flags = []
            if r["security_packages"]:
                flags.append(f"{r['security_packages']} security")
            if r["reboot_required"]:
                flags.append("reboot required")
            extra = f" [{', '.join(flags)}]" if flags else ""
            lines.append(f"  • {r['server']} ({r['hostname']}) — {r['packages_available']} pkg{extra}")
        if len(p["pending"]) > 30:
            lines.append(f"  …and {len(p['pending']) - 30} more")
        lines.append("")
    sev = p["cve_summary"]["by_severity"]
    if sum(sev.values()):
        lines.append("CVE summary (new USNs this week):")
        for label in ("critical", "high", "medium", "low", "unknown"):
            if sev.get(label):
                lines.append(f"  {label}: {sev[label]}")
        lines.append("")
    health = p["health"]
    if any(health.values()):
        lines.append("Health flags:")
        if health["offline_24h"]:
            lines.append(f"  offline >24h: {', '.join(r['server'] for r in health['offline_24h'])}")
        if health["boot_disk_alerts"]:
            lines.append(
                "  /boot low: "
                + ", ".join(
                    f"{r['server']} ({r['boot_free_mb']}/{r['boot_total_mb']} MB)"
                    for r in health["boot_disk_alerts"]
                )
            )
        if health["kernel_age_180d"]:
            lines.append(
                "  kernel >180d: "
                + ", ".join(f"{r['server']} ({r['kernel_age_days']}d)" for r in health["kernel_age_180d"])
            )
        if health["eol_within_90d"]:
            lines.append(
                "  OS EOL ≤90d: "
                + ", ".join(f"{r['server']} ({r['days_remaining']}d)" for r in health["eol_within_90d"])
            )
        lines.append("")
    lines.append("See /reports for the full breakdown.")
    return "\n".join(lines)


def _build_weekly_html(subject: str, p: dict) -> str:  # noqa: C901
    h = p["headline"]
    sev = p["cve_summary"]["by_severity"]
    health = p["health"]

    def stat_card(value, label, color):
        return (
            f'<td width="25%" style="padding:4px;">'
            f'<div style="background:#fff;border-radius:8px;padding:14px 8px;'
            f'text-align:center;border:1px solid #e5e7eb;">'
            f'<div style="font-size:24px;font-weight:700;color:{color};font-family:-apple-system,monospace;">{value}</div>'
            f'<div style="font-size:11px;color:#6b7280;margin-top:3px;">{label}</div>'
            f'</div></td>'
        )

    overview = (
        '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr>'
        + stat_card(h["packages_upgraded"], "Packages upgraded", "#16a34a")
        + stat_card(h["servers_upgraded"], "Servers upgraded", "#0891b2")
        + stat_card(h["servers_pending"], "Pending", "#d97706" if h["servers_pending"] else "#6b7280")
        + stat_card(h["new_cves"], "New CVEs", "#dc2626" if h["new_cves"] else "#6b7280")
        + '</tr></table>'
    )

    # By-server table
    by_server_rows = ""
    for r in p["by_server"][:50]:
        status_color = {
            "ok": "#16a34a",
            "pending": "#d97706",
            "error": "#dc2626",
            "no-check": "#6b7280",
        }.get(r["status"], "#6b7280")
        last_check = (r["last_check"] or "").replace("T", " ")[:16]
        by_server_rows += (
            f"<tr style='border-bottom:1px solid #f3f4f6;'>"
            f"<td style='padding:6px 10px;font-size:13px;color:#111827;'><strong>{r['server']}</strong>"
            f"<div style='font-size:11px;color:#6b7280;font-family:monospace;'>{r['hostname']}</div></td>"
            f"<td style='padding:6px 10px;text-align:right;font-family:monospace;font-size:12px;'>{r['runs']}</td>"
            f"<td style='padding:6px 10px;text-align:right;font-family:monospace;font-size:12px;color:#16a34a;'>{r['packages']}</td>"
            f"<td style='padding:6px 10px;font-family:monospace;font-size:11px;color:#6b7280;'>{last_check}</td>"
            f"<td style='padding:6px 10px;text-align:right;'>"
            f"<span style='display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;"
            f"background:#f3f4f6;color:{status_color};font-weight:600;'>{r['status']}</span></td>"
            f"</tr>"
        )
    by_server_section = ""
    if by_server_rows:
        by_server_section = (
            "<div style='background:#fff;border-radius:8px;border:1px solid #e5e7eb;margin-bottom:12px;overflow:hidden;'>"
            "<div style='background:#f9fafb;padding:10px 16px;border-bottom:1px solid #e5e7eb;'>"
            "<span style='font-size:14px;font-weight:600;color:#111827;'>By server (last 7 days)</span></div>"
            "<table width='100%' style='border-collapse:collapse;'>"
            "<thead><tr style='background:#f9fafb;'>"
            "<th style='padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;'>SERVER</th>"
            "<th style='padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;'>RUNS</th>"
            "<th style='padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;'>PKGS</th>"
            "<th style='padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;'>LAST CHECK</th>"
            "<th style='padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;'>STATUS</th>"
            f"</tr></thead><tbody>{by_server_rows}</tbody></table></div>"
        )

    # Pending list
    pending_rows = ""
    for r in p["pending"][:30]:
        sec_badge = (
            f"<span style='display:inline-block;background:#fef2f2;color:#dc2626;"
            f"font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;'>"
            f"{r['security_packages']} security</span>"
            if r["security_packages"] else ""
        )
        reboot_badge = (
            "<span style='display:inline-block;background:#fef3c7;color:#92400e;"
            "font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;'>↻ reboot</span>"
            if r["reboot_required"] else ""
        )
        pending_rows += (
            f"<tr style='border-bottom:1px solid #f3f4f6;'>"
            f"<td style='padding:6px 10px;font-size:13px;color:#111827;'><strong>{r['server']}</strong>"
            f"<div style='font-size:11px;color:#6b7280;font-family:monospace;'>{r['hostname']}</div></td>"
            f"<td style='padding:6px 10px;text-align:right;font-family:monospace;font-size:12px;color:#d97706;'>{r['packages_available']}{sec_badge}{reboot_badge}</td>"
            f"</tr>"
        )
    pending_section = ""
    if pending_rows:
        pending_section = (
            "<div style='background:#fff;border-radius:8px;border:1px solid #fde68a;margin-bottom:12px;overflow:hidden;'>"
            "<div style='background:#fffbeb;padding:10px 16px;border-bottom:1px solid #fde68a;'>"
            f"<span style='font-size:14px;font-weight:600;color:#92400e;'>Still pending — oldest first ({len(p['pending'])} server(s))</span></div>"
            f"<table width='100%' style='border-collapse:collapse;'>{pending_rows}</table></div>"
        )

    # CVE
    cve_rows = ""
    for label, color in (
        ("critical", "#7f1d1d"),
        ("high", "#dc2626"),
        ("medium", "#d97706"),
        ("low", "#0891b2"),
        ("unknown", "#6b7280"),
    ):
        n = sev.get(label, 0)
        if n:
            cve_rows += (
                f"<tr><td style='padding:4px 10px;font-size:13px;text-transform:capitalize;color:{color};font-weight:600;'>{label}</td>"
                f"<td style='padding:4px 10px;text-align:right;font-family:monospace;'>{n}</td></tr>"
            )
    cve_section = ""
    if cve_rows:
        cve_section = (
            "<div style='background:#fff;border-radius:8px;border:1px solid #fca5a5;margin-bottom:12px;overflow:hidden;'>"
            "<div style='background:#fef2f2;padding:10px 16px;border-bottom:1px solid #fca5a5;'>"
            f"<span style='font-size:14px;font-weight:600;color:#dc2626;'>New CVEs this week — {p['cve_summary']['package_count']} package(s), {p['cve_summary']['affected_servers']} affected server(s)</span></div>"
            f"<table width='100%' style='border-collapse:collapse;'>{cve_rows}</table></div>"
        )

    # Health
    health_items = []
    if health["offline_24h"]:
        items = ", ".join(f"<strong>{r['server']}</strong>" for r in health["offline_24h"])
        health_items.append(f"<li><span style='color:#dc2626;'>Offline &gt;24h:</span> {items}</li>")
    if health["boot_disk_alerts"]:
        items = ", ".join(
            f"<strong>{r['server']}</strong> ({r['boot_free_mb']}/{r['boot_total_mb']} MB)"
            for r in health["boot_disk_alerts"]
        )
        health_items.append(f"<li><span style='color:#d97706;'>/boot &lt;10% free:</span> {items}</li>")
    if health["kernel_age_180d"]:
        items = ", ".join(
            f"<strong>{r['server']}</strong> ({r['kernel_age_days']}d)"
            for r in health["kernel_age_180d"]
        )
        health_items.append(f"<li><span style='color:#d97706;'>Kernel age &gt;180d:</span> {items}</li>")
    if health["eol_within_90d"]:
        items = ", ".join(
            f"<strong>{r['server']}</strong> ({r['days_remaining']}d to {r['eol_date']})"
            for r in health["eol_within_90d"]
        )
        health_items.append(f"<li><span style='color:#dc2626;'>OS EOL ≤90d:</span> {items}</li>")
    health_section = ""
    if health_items:
        health_section = (
            "<div style='background:#fff;border-radius:8px;border:1px solid #e5e7eb;margin-bottom:12px;overflow:hidden;'>"
            "<div style='background:#f9fafb;padding:10px 16px;border-bottom:1px solid #e5e7eb;'>"
            "<span style='font-size:14px;font-weight:600;color:#111827;'>Health flags</span></div>"
            f"<ul style='margin:0;padding:12px 16px 12px 32px;font-size:13px;color:#374151;line-height:1.7;'>{''.join(health_items)}</ul></div>"
        )

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>{subject}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:#1a1f2e;border-radius:8px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:11px;color:#60a5fa;letter-spacing:.1em;font-weight:600;text-transform:uppercase;margin-bottom:4px;">APT-UI · WEEKLY DIGEST</div>
    <div style="font-size:20px;font-weight:700;color:#f9fafb;">{p['date_range']}</div>
    <div style="font-size:12px;color:#9ca3af;margin-top:4px;">
      {h['packages_upgraded']} packages upgraded · {h['servers_upgraded']} servers · {h['servers_pending']} pending · {h['new_cves']} new CVEs
    </div>
  </div>
  {overview}
  {by_server_section}
  {pending_section}
  {cve_section}
  {health_section}
  <div style="text-align:center;padding:16px 0 0;font-size:11px;color:#9ca3af;">
    <a href="/reports" style="color:#60a5fa;text-decoration:none;">View full reports →</a>
    <div style="margin-top:6px;">apt-ui · weekly digest</div>
  </div>
</div></body></html>"""


def _build_weekly_telegram(subject: str, p: dict) -> str:
    h = p["headline"]
    sev = p["cve_summary"]["by_severity"]
    health = p["health"]
    lines = [f"*apt-ui weekly digest*", f"_{p['date_range']}_", ""]
    lines.append(
        f"📦 *{h['packages_upgraded']}* pkgs upgraded "
        f"({h['security_packages_upgraded']} security) on *{h['servers_upgraded']}* server(s)"
    )
    if h["servers_pending"]:
        lines.append(f"⏳ *{h['servers_pending']}* server(s) still pending")
    if h["new_cves"]:
        lines.append(
            f"🛡️ *{h['new_cves']}* new CVE(s) across {h['new_cve_packages']} pkg(s); "
            f"{h['affected_servers_for_new_cves']} affected"
        )
    lines.append("")
    if p["by_server"]:
        lines.append("*Top movers:*")
        for r in p["by_server"][:8]:
            lines.append(f"  • `{r['server']}` — {r['packages']} pkg, {r['runs']} run(s)")
        lines.append("")
    if p["pending"]:
        lines.append("*Still pending (oldest first):*")
        for r in p["pending"][:8]:
            extras = []
            if r["security_packages"]:
                extras.append(f"{r['security_packages']} sec")
            if r["reboot_required"]:
                extras.append("↻")
            extra = f" \\[{', '.join(extras)}]" if extras else ""
            lines.append(f"  • `{r['server']}` — {r['packages_available']} pkg{extra}")
        if len(p["pending"]) > 8:
            lines.append(f"  …and {len(p['pending']) - 8} more")
        lines.append("")
    if sum(sev.values()):
        parts = [f"{label}: {sev[label]}" for label in ("critical", "high", "medium", "low") if sev.get(label)]
        if parts:
            lines.append("*New CVEs:* " + ", ".join(parts))
    flag_parts = []
    if health["offline_24h"]:
        flag_parts.append(f"{len(health['offline_24h'])} offline >24h")
    if health["boot_disk_alerts"]:
        flag_parts.append(f"{len(health['boot_disk_alerts'])} /boot low")
    if health["kernel_age_180d"]:
        flag_parts.append(f"{len(health['kernel_age_180d'])} kernel >180d")
    if health["eol_within_90d"]:
        flag_parts.append(f"{len(health['eol_within_90d'])} EOL ≤90d")
    if flag_parts:
        lines.append("*Health:* " + " · ".join(flag_parts))
    return "\n".join(lines)


async def send_weekly_digest(cfg: NotificationConfig, db: AsyncSession) -> dict:
    """Compose and dispatch the weekly digest. Returns per-channel send results."""
    payload = await compose_weekly_digest(db)
    subject = payload["subject"]

    results: dict[str, str] = {"email": "skipped", "telegram": "skipped", "webhook": "skipped"}

    if cfg.email_enabled and getattr(cfg, "notify_weekly_digest_email", True):
        try:
            await _send_email(
                cfg, subject, payload["html_body"], payload["text_body"],
                event_type="weekly_digest",
            )
            results["email"] = "sent"
        except Exception as exc:
            logger.error("Weekly digest email failed: %s", exc)
            results["email"] = f"error: {exc}"

    if cfg.telegram_enabled and getattr(cfg, "notify_weekly_digest_telegram", True):
        try:
            await _send_telegram(cfg, payload["telegram_body"], event_type="weekly_digest")
            results["telegram"] = "sent"
        except Exception as exc:
            logger.error("Weekly digest telegram failed: %s", exc)
            results["telegram"] = f"error: {exc}"

    if cfg.webhook_enabled and getattr(cfg, "notify_weekly_digest_webhook", True):
        try:
            # Webhook payload mirrors daily_summary shape: structured JSON,
            # `event` discriminator added by _send_webhook.
            wh_payload = {
                "date_range": payload["date_range"],
                "generated_at": payload["generated_at"],
                "headline": payload["headline"],
                "by_server": payload["by_server"],
                "pending": payload["pending"],
                "cve_summary": payload["cve_summary"],
                "health": payload["health"],
            }
            await _send_webhook(cfg, "weekly_digest", wh_payload)
            results["webhook"] = "sent"
        except Exception as exc:
            logger.error("Weekly digest webhook failed: %s", exc)
            results["webhook"] = f"error: {exc}"

    return results


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
