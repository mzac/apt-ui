from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from backend.config import DATABASE_URL


engine = create_async_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


async def _migrate_string_tags(conn):
    """
    Migrate legacy string tags from servers.tags (JSON list of strings) into the
    tags + server_tags tables.  Runs idempotently — already-migrated tags are skipped.
    """
    import json
    import sqlalchemy as sa

    PALETTE = [
        '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
        '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a3e635',
        '#e879f9', '#fb7185', '#34d399', '#60a5fa', '#fbbf24',
    ]

    # Fetch all servers that have a non-null legacy tags column
    rows = (await conn.execute(sa.text("SELECT id, tags FROM servers WHERE tags IS NOT NULL"))).fetchall()

    # Build a mapping: tag_name -> tag_id (pre-existing)
    existing = (await conn.execute(sa.text("SELECT id, name FROM tags"))).fetchall()
    tag_map: dict[str, int] = {r[1]: r[0] for r in existing}

    color_idx = len(tag_map)  # pick colors after existing ones

    for server_id, tags_json in rows:
        try:
            tag_names: list[str] = json.loads(tags_json) if tags_json else []
        except Exception:
            tag_names = []

        for name in tag_names:
            name = name.strip()
            if not name:
                continue

            # Create tag if it doesn't exist
            if name not in tag_map:
                color = PALETTE[color_idx % len(PALETTE)]
                color_idx += 1
                result = await conn.execute(
                    sa.text("INSERT OR IGNORE INTO tags (name, color, sort_order) VALUES (:name, :color, 0)"),
                    {"name": name, "color": color},
                )
                # Fetch the id (may have been inserted by a previous iteration)
                tid_row = (await conn.execute(sa.text("SELECT id FROM tags WHERE name = :name"), {"name": name})).fetchone()
                if tid_row:
                    tag_map[name] = tid_row[0]

            tag_id = tag_map.get(name)
            if tag_id is None:
                continue

            # Create server_tag association if it doesn't exist
            await conn.execute(
                sa.text(
                    "INSERT OR IGNORE INTO server_tags (server_id, tag_id) VALUES (:sid, :tid)"
                ),
                {"sid": server_id, "tid": tag_id},
            )


async def _migrate_primary_group_to_memberships(conn):
    """
    Migrate existing servers.group_id into server_group_memberships so the new
    multi-group system reflects the existing primary group assignment.
    """
    import sqlalchemy as sa

    rows = (await conn.execute(
        sa.text("SELECT id, group_id FROM servers WHERE group_id IS NOT NULL")
    )).fetchall()

    for server_id, group_id in rows:
        await conn.execute(
            sa.text(
                "INSERT OR IGNORE INTO server_group_memberships (server_id, group_id) "
                "VALUES (:sid, :gid)"
            ),
            {"sid": server_id, "gid": group_id},
        )


async def init_db():
    from backend import models  # noqa: F401 — ensure models are registered
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Apply incremental column migrations for existing databases.
        # SQLite supports ALTER TABLE ADD COLUMN but not IF NOT EXISTS,
        # so we catch the error when a column already exists.
        migrations = [
            "ALTER TABLE update_checks ADD COLUMN autoremove_count INTEGER DEFAULT 0",
            "ALTER TABLE update_checks ADD COLUMN autoremove_packages TEXT",
            "ALTER TABLE servers ADD COLUMN os_info TEXT",
            "ALTER TABLE servers ADD COLUMN is_enabled BOOLEAN DEFAULT 1",
            "ALTER TABLE servers ADD COLUMN tags TEXT",
            "ALTER TABLE server_stats ADD COLUMN cpu_count INTEGER",
            "ALTER TABLE server_stats ADD COLUMN mem_total_mb INTEGER",
            "ALTER TABLE server_stats ADD COLUMN virt_type TEXT",
            "ALTER TABLE notification_config ADD COLUMN daily_summary_email BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN daily_summary_telegram BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_upgrade_email BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_upgrade_telegram BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_error_email BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_error_telegram BOOLEAN DEFAULT 1",
            "ALTER TABLE schedule_config ADD COLUMN auto_tag_os BOOLEAN DEFAULT 0",
            "ALTER TABLE schedule_config ADD COLUMN auto_tag_virt BOOLEAN DEFAULT 0",
            "ALTER TABLE schedule_config ADD COLUMN run_apt_update_before_upgrade BOOLEAN DEFAULT 0",
            "ALTER TABLE schedule_config ADD COLUMN conffile_action TEXT DEFAULT 'confdef_confold'",
            "ALTER TABLE servers ADD COLUMN ssh_private_key_enc TEXT",
            "ALTER TABLE server_stats ADD COLUMN auto_security_updates TEXT",
            "ALTER TABLE schedule_config ADD COLUMN reachability_ttl_minutes INTEGER DEFAULT 5",
            "ALTER TABLE server_stats ADD COLUMN eeprom_update_available TEXT",
            "ALTER TABLE server_stats ADD COLUMN eeprom_current_version TEXT",
            "ALTER TABLE server_stats ADD COLUMN eeprom_latest_version TEXT",
            "ALTER TABLE server_stats ADD COLUMN host_ips TEXT",
            "ALTER TABLE servers ADD COLUMN notes TEXT",
            "ALTER TABLE notification_config ADD COLUMN webhook_enabled BOOLEAN DEFAULT 0",
            "ALTER TABLE notification_config ADD COLUMN webhook_url TEXT",
            "ALTER TABLE notification_config ADD COLUMN webhook_secret TEXT",
            "ALTER TABLE notification_config ADD COLUMN daily_summary_webhook BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_upgrade_webhook BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_error_webhook BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_security_updates BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_security_email BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_security_telegram BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_security_webhook BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_reboot_required BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_reboot_email BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_reboot_telegram BOOLEAN DEFAULT 1",
            "ALTER TABLE notification_config ADD COLUMN notify_reboot_webhook BOOLEAN DEFAULT 1",
            "ALTER TABLE server_stats ADD COLUMN apt_proxy TEXT",
            "ALTER TABLE servers ADD COLUMN is_reachable BOOLEAN DEFAULT 1",
            "ALTER TABLE servers ADD COLUMN last_seen DATETIME",
            "ALTER TABLE server_stats ADD COLUMN kernel_install_date DATETIME",
            "ALTER TABLE server_stats ADD COLUMN boot_free_mb INTEGER",
            "ALTER TABLE server_stats ADD COLUMN boot_total_mb INTEGER",
            "ALTER TABLE users ADD COLUMN totp_secret_enc TEXT",
            "ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN DEFAULT 0",
            "ALTER TABLE schedule_config ADD COLUMN staged_rollout_enabled BOOLEAN DEFAULT 0",
            "ALTER TABLE schedule_config ADD COLUMN ring_promotion_delay_hours INTEGER DEFAULT 24",
            "ALTER TABLE server_stats ADD COLUMN snapshot_capability TEXT",
            # api_tokens table is created by Base.metadata.create_all (new table — no migration needed)
        ]
        for sql in migrations:
            try:
                await conn.execute(__import__('sqlalchemy').text(sql))
            except Exception:
                pass  # Column already exists — ignore

        # Migrate legacy string tags to the new tags/server_tags tables
        try:
            await _migrate_string_tags(conn)
        except Exception:
            pass

        # Migrate existing primary group_id to server_group_memberships
        try:
            await _migrate_primary_group_to_memberships(conn)
        except Exception:
            pass
