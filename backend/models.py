from datetime import datetime
from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Integer, Text, func
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    last_login: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ServerGroup(Base):
    __tablename__ = "server_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    color: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    servers: Mapped[list["Server"]] = relationship("Server", back_populates="group")
    memberships: Mapped[list["ServerGroupMembership"]] = relationship(
        "ServerGroupMembership", back_populates="group", cascade="all, delete-orphan"
    )


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    color: Mapped[str] = mapped_column(Text, default='#6366f1')
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    server_tags: Mapped[list["ServerTag"]] = relationship(
        "ServerTag", back_populates="tag", cascade="all, delete-orphan"
    )


class ServerTag(Base):
    __tablename__ = "server_tags"

    server_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )

    server: Mapped["Server"] = relationship("Server", back_populates="server_tags")
    tag: Mapped["Tag"] = relationship("Tag", back_populates="server_tags")


class ServerGroupMembership(Base):
    __tablename__ = "server_group_memberships"

    server_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True
    )
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("server_groups.id", ondelete="CASCADE"), primary_key=True
    )

    server: Mapped["Server"] = relationship("Server", back_populates="group_memberships")
    group: Mapped["ServerGroup"] = relationship("ServerGroup", back_populates="memberships")


class Server(Base):
    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    hostname: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    username: Mapped[str] = mapped_column(Text, nullable=False)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22)
    group_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("server_groups.id"), nullable=True)
    os_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list of tag strings (legacy)
    ssh_private_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)  # Fernet-encrypted PEM key
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)  # free-text admin notes
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), onupdate=func.now())

    group: Mapped["ServerGroup | None"] = relationship("ServerGroup", back_populates="servers")
    server_tags: Mapped[list["ServerTag"]] = relationship(
        "ServerTag", back_populates="server", cascade="all, delete-orphan"
    )
    group_memberships: Mapped[list["ServerGroupMembership"]] = relationship(
        "ServerGroupMembership", back_populates="server", cascade="all, delete-orphan"
    )
    update_checks: Mapped[list["UpdateCheck"]] = relationship(
        "UpdateCheck", back_populates="server", cascade="all, delete-orphan"
    )
    update_history: Mapped[list["UpdateHistory"]] = relationship(
        "UpdateHistory", back_populates="server", cascade="all, delete-orphan"
    )
    server_stats: Mapped[list["ServerStats"]] = relationship(
        "ServerStats", back_populates="server", cascade="all, delete-orphan"
    )


class UpdateCheck(Base):
    __tablename__ = "update_checks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[int] = mapped_column(Integer, ForeignKey("servers.id"), nullable=False)
    checked_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    status: Mapped[str] = mapped_column(Text, nullable=False)  # success / error
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    packages_available: Mapped[int] = mapped_column(Integer, default=0)
    security_packages: Mapped[int] = mapped_column(Integer, default=0)
    regular_packages: Mapped[int] = mapped_column(Integer, default=0)
    held_packages: Mapped[int] = mapped_column(Integer, default=0)
    held_packages_list: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    autoremove_count: Mapped[int] = mapped_column(Integer, default=0)
    autoremove_packages: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list of names
    reboot_required: Mapped[bool] = mapped_column(Boolean, default=False)
    raw_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    packages_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON array

    server: Mapped["Server"] = relationship("Server", back_populates="update_checks")


class UpdateHistory(Base):
    __tablename__ = "update_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[int] = mapped_column(Integer, ForeignKey("servers.id"), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False)  # running / success / error
    action: Mapped[str] = mapped_column(Text, nullable=False)  # upgrade / dist-upgrade
    phased_updates: Mapped[bool] = mapped_column(Boolean, default=False)
    packages_upgraded: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    log_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    initiated_by: Mapped[str] = mapped_column(Text, default="manual")  # manual / scheduled

    server: Mapped["Server"] = relationship("Server", back_populates="update_history")


class ServerStats(Base):
    __tablename__ = "server_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[int] = mapped_column(Integer, ForeignKey("servers.id"), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    uptime_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    kernel_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    disk_usage_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_apt_update: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    total_packages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cpu_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mem_total_mb: Mapped[int | None] = mapped_column(Integer, nullable=True)
    virt_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    auto_security_updates: Mapped[str | None] = mapped_column(Text, nullable=True)  # not_installed / disabled / enabled
    eeprom_update_available: Mapped[str | None] = mapped_column(Text, nullable=True)  # up_to_date / update_available / update_staged / error / frozen
    eeprom_current_version: Mapped[str | None] = mapped_column(Text, nullable=True)  # unix timestamp string of current bootloader version
    eeprom_latest_version: Mapped[str | None] = mapped_column(Text, nullable=True)   # unix timestamp string of latest available version
    host_ips: Mapped[str | None] = mapped_column(Text, nullable=True)               # JSON list of IPs from `hostname -I` — used for Docker host detection
    apt_proxy: Mapped[str | None] = mapped_column(Text, nullable=True)             # apt HTTP proxy URL if configured (e.g. apt-cacher-ng), else None

    server: Mapped["Server"] = relationship("Server", back_populates="server_stats")


class NotificationConfig(Base):
    __tablename__ = "notification_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    email_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    smtp_host: Mapped[str | None] = mapped_column(Text, nullable=True)
    smtp_port: Mapped[int] = mapped_column(Integer, default=587)
    smtp_use_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    smtp_username: Mapped[str | None] = mapped_column(Text, nullable=True)
    smtp_password: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_from: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_to: Mapped[str | None] = mapped_column(Text, nullable=True)
    telegram_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    telegram_bot_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    telegram_chat_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    daily_summary_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    daily_summary_time: Mapped[str] = mapped_column(Text, default="07:00")
    notify_on_upgrade_complete: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_on_error: Mapped[bool] = mapped_column(Boolean, default=True)
    daily_summary_email: Mapped[bool] = mapped_column(Boolean, default=True)
    daily_summary_telegram: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_upgrade_email: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_upgrade_telegram: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_error_email: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_error_telegram: Mapped[bool] = mapped_column(Boolean, default=True)
    webhook_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    webhook_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    webhook_secret: Mapped[str | None] = mapped_column(Text, nullable=True)  # optional HMAC-SHA256 secret
    daily_summary_webhook: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_upgrade_webhook: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_error_webhook: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_security_updates: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_security_email: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_security_telegram: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_security_webhook: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_reboot_required: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_reboot_email: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_reboot_telegram: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_reboot_webhook: Mapped[bool] = mapped_column(Boolean, default=True)


class ScheduleConfig(Base):
    __tablename__ = "schedule_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    check_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    check_cron: Mapped[str] = mapped_column(Text, default="0 6 * * *")
    auto_upgrade_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_upgrade_cron: Mapped[str | None] = mapped_column(Text, nullable=True)
    allow_phased_on_auto: Mapped[bool] = mapped_column(Boolean, default=False)
    upgrade_concurrency: Mapped[int] = mapped_column(Integer, default=5)
    log_retention_days: Mapped[int] = mapped_column(Integer, default=90)
    auto_tag_os: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_tag_virt: Mapped[bool] = mapped_column(Boolean, default=False)
    run_apt_update_before_upgrade: Mapped[bool] = mapped_column(Boolean, default=False)
    conffile_action: Mapped[str] = mapped_column(Text, default="confdef_confold")
    reachability_ttl_minutes: Mapped[int] = mapped_column(Integer, default=5)
    # conffile_action controls what apt-get does when a package ships a new version
    # of a config file that has been locally modified:
    #   confdef_confold — use the package's default answer; if none, keep existing (safest)
    #   confold         — always keep the existing file
    #   confnew         — always take the new file from the package


class AppConfig(Base):
    """Generic key-value store for app-wide persistent settings (e.g. JWT secret)."""
    __tablename__ = "app_config"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class AptCacheServer(Base):
    __tablename__ = "apt_cache_servers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    host: Mapped[str] = mapped_column(Text, nullable=False)
    port: Mapped[int] = mapped_column(Integer, default=3142)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())


class Template(Base):
    __tablename__ = "templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())

    packages: Mapped[list["TemplatePackage"]] = relationship(
        "TemplatePackage", back_populates="template", cascade="all, delete-orphan"
    )


class TemplatePackage(Base):
    __tablename__ = "template_packages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    template_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("templates.id", ondelete="CASCADE"), nullable=False
    )
    package_name: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    template: Mapped["Template"] = relationship("Template", back_populates="packages")
