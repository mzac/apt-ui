export interface User {
  id: number
  username: string
  is_admin: boolean
  created_at: string
  last_login: string | null
  is_default_password: boolean
}

export interface ServerGroup {
  id: number
  name: string
  color: string | null
  sort_order: number
  server_count: number
}

export interface LatestCheck {
  checked_at: string | null
  status: string | null
  packages_available: number
  security_packages: number
  regular_packages: number
  held_packages: number
  autoremove_count: number
  reboot_required: boolean
  error_message: string | null
}

export interface Server {
  id: number
  name: string
  hostname: string
  username: string
  ssh_port: number
  group_id: number | null
  group_name: string | null
  group_color: string | null
  os_info: string | null
  tags: string[]
  is_enabled: boolean
  created_at: string
  updated_at: string
  latest_check: LatestCheck | null
}

export interface PackageInfo {
  name: string
  current_version: string
  available_version: string
  repository: string
  is_security: boolean
  is_phased: boolean
}

export interface UpdateHistory {
  id: number
  server_id: number
  started_at: string
  completed_at: string | null
  status: string
  action: string
  phased_updates: boolean
  packages_upgraded: string[] | null
  log_output: string | null
  initiated_by: string
}

export interface FleetOverview {
  total_servers: number
  up_to_date: number
  updates_available: number
  security_updates_total: number
  errors: number
  reboot_required: number
  held_packages_total: number
  autoremove_total: number
  last_check_time: string | null
  next_check_time: string | null
}

export interface ScheduleConfig {
  id: number
  check_enabled: boolean
  check_cron: string
  auto_upgrade_enabled: boolean
  auto_upgrade_cron: string | null
  allow_phased_on_auto: boolean
  upgrade_concurrency: number
  log_retention_days: number
  next_check_time: string | null
  next_upgrade_time: string | null
  timezone: string
}

export interface NotificationConfig {
  id: number
  email_enabled: boolean
  smtp_host: string | null
  smtp_port: number
  smtp_use_tls: boolean
  smtp_username: string | null
  smtp_password: string | null
  email_from: string | null
  email_to: string | null
  telegram_enabled: boolean
  telegram_bot_token: string | null
  telegram_chat_id: string | null
  daily_summary_enabled: boolean
  daily_summary_time: string
  notify_on_upgrade_complete: boolean
  notify_on_error: boolean
}

export type ServerStatus = 'up_to_date' | 'updates_available' | 'error' | 'checking' | 'upgrading' | 'disabled' | 'unknown'
