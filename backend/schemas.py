from datetime import datetime
from typing import Optional
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class UserOut(BaseModel):
    id: int
    username: str
    is_admin: bool
    created_at: datetime
    last_login: Optional[datetime] = None
    is_default_password: bool = False

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Server Groups
# ---------------------------------------------------------------------------

class ServerGroupCreate(BaseModel):
    name: str
    color: Optional[str] = None
    sort_order: int = 0


class ServerGroupUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None


class ServerGroupOut(BaseModel):
    id: int
    name: str
    color: Optional[str] = None
    sort_order: int
    server_count: int = 0

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Servers
# ---------------------------------------------------------------------------

class ServerCreate(BaseModel):
    name: str
    hostname: str
    username: str
    ssh_port: int = 22
    group_id: Optional[int] = None


class ServerUpdate(BaseModel):
    name: Optional[str] = None
    hostname: Optional[str] = None
    username: Optional[str] = None
    ssh_port: Optional[int] = None
    group_id: Optional[int] = None
    is_enabled: Optional[bool] = None


class LatestCheckOut(BaseModel):
    checked_at: Optional[datetime] = None
    status: Optional[str] = None
    packages_available: int = 0
    security_packages: int = 0
    regular_packages: int = 0
    held_packages: int = 0
    autoremove_count: int = 0
    reboot_required: bool = False
    error_message: Optional[str] = None

    model_config = {"from_attributes": True}


class ServerOut(BaseModel):
    id: int
    name: str
    hostname: str
    username: str
    ssh_port: int
    group_id: Optional[int] = None
    group_name: Optional[str] = None
    group_color: Optional[str] = None
    os_info: Optional[str] = None
    is_enabled: bool
    created_at: datetime
    updated_at: datetime
    latest_check: Optional[LatestCheckOut] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Update checks / packages
# ---------------------------------------------------------------------------

class PackageInfo(BaseModel):
    name: str
    current_version: str
    available_version: str
    repository: str
    is_security: bool
    is_phased: bool


class UpdateCheckOut(BaseModel):
    id: int
    server_id: int
    checked_at: datetime
    status: str
    error_message: Optional[str] = None
    packages_available: int
    security_packages: int
    regular_packages: int
    held_packages: int
    held_packages_list: Optional[list[str]] = None
    reboot_required: bool
    packages_json: Optional[list[PackageInfo]] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Upgrade / history
# ---------------------------------------------------------------------------

class UpgradeRequest(BaseModel):
    action: str = "upgrade"  # "upgrade" | "dist-upgrade"
    allow_phased: bool = False


class UpdateHistoryOut(BaseModel):
    id: int
    server_id: int
    started_at: datetime
    completed_at: Optional[datetime] = None
    status: str
    action: str
    phased_updates: bool
    packages_upgraded: Optional[list] = None
    log_output: Optional[str] = None
    initiated_by: str

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

class FleetOverview(BaseModel):
    total_servers: int
    up_to_date: int
    updates_available: int
    security_updates_total: int
    errors: int
    reboot_required: int
    held_packages_total: int
    autoremove_total: int = 0
    last_check_time: Optional[datetime] = None
    next_check_time: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

class ScheduleConfigOut(BaseModel):
    id: int
    check_enabled: bool
    check_cron: str
    auto_upgrade_enabled: bool
    auto_upgrade_cron: Optional[str] = None
    allow_phased_on_auto: bool
    upgrade_concurrency: int
    log_retention_days: int
    next_check_time: Optional[datetime] = None
    next_upgrade_time: Optional[datetime] = None
    timezone: str = ""

    model_config = {"from_attributes": True}


class ScheduleConfigUpdate(BaseModel):
    check_enabled: Optional[bool] = None
    check_cron: Optional[str] = None
    auto_upgrade_enabled: Optional[bool] = None
    auto_upgrade_cron: Optional[str] = None
    allow_phased_on_auto: Optional[bool] = None
    upgrade_concurrency: Optional[int] = None
    log_retention_days: Optional[int] = None


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

class NotificationConfigOut(BaseModel):
    id: int
    email_enabled: bool
    smtp_host: Optional[str] = None
    smtp_port: int
    smtp_use_tls: bool
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None  # masked in responses
    email_from: Optional[str] = None
    email_to: Optional[str] = None
    telegram_enabled: bool
    telegram_bot_token: Optional[str] = None  # masked in responses
    telegram_chat_id: Optional[str] = None
    daily_summary_enabled: bool
    daily_summary_time: str
    notify_on_upgrade_complete: bool
    notify_on_error: bool

    model_config = {"from_attributes": True}


class NotificationConfigUpdate(BaseModel):
    email_enabled: Optional[bool] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_use_tls: Optional[bool] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    email_from: Optional[str] = None
    email_to: Optional[str] = None
    telegram_enabled: Optional[bool] = None
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    daily_summary_enabled: Optional[bool] = None
    daily_summary_time: Optional[str] = None
    notify_on_upgrade_complete: Optional[bool] = None
    notify_on_error: Optional[bool] = None
