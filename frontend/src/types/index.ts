export interface User {
  id: number
  username: string
  is_admin: boolean
  created_at: string
  last_login: string | null
  is_default_password: boolean
}

export interface Tag {
  id: number
  name: string
  color: string
  sort_order: number
  server_count: number
}

export interface GroupRef {
  id: number
  name: string
  color: string | null
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
  groups: GroupRef[]
  os_info: string | null
  tags: Tag[]
  is_enabled: boolean
  ssh_key_configured: boolean
  created_at: string
  updated_at: string
  latest_check: LatestCheck | null
  cpu_count: number | null
  mem_total_mb: number | null
  kernel_version: string | null
  uptime_seconds: number | null
  virt_type: string | null
  auto_security_updates: string | null  // not_installed / disabled / enabled
  eeprom_update_available: string | null  // up_to_date / update_available / update_staged / error / frozen
  eeprom_current_version: string | null   // unix timestamp string
  eeprom_latest_version: string | null    // unix timestamp string
  last_apt_update: string | null          // ISO datetime when apt cache was last refreshed on the server
  notes: string | null                    // free-text admin notes
}

export interface PackageInfo {
  name: string
  current_version: string
  available_version: string
  repository: string
  is_security: boolean
  is_phased: boolean
  description?: string
}

export interface PackageSearchResult {
  name: string
  description: string
  installed_size: number
  download_size: number
  version: string
  section: string
  is_installed: boolean
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
  auto_tag_os: boolean
  auto_tag_virt: boolean
  run_apt_update_before_upgrade: boolean
  conffile_action: string
  reachability_ttl_minutes: number
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
  daily_summary_email: boolean
  daily_summary_telegram: boolean
  notify_upgrade_email: boolean
  notify_upgrade_telegram: boolean
  notify_error_email: boolean
  notify_error_telegram: boolean
  webhook_enabled: boolean
  webhook_url: string | null
  webhook_secret: string | null
}

export interface TemplatePackage {
  id: number
  template_id: number
  package_name: string
  notes: string | null
}

export interface Template {
  id: number
  name: string
  description: string | null
  created_at: string
  packages: TemplatePackage[]
}

export interface CheckAllProgress {
  running: boolean
  total: number
  done: number
  current_servers: string[]
  results: Record<string, string>
}

export type ServerStatus = 'up_to_date' | 'updates_available' | 'error' | 'checking' | 'upgrading' | 'disabled' | 'unknown'

export interface AptCacheServer {
  id: number
  label: string
  host: string
  port: number
  enabled: boolean
}

export interface AptCacheDailyRow {
  period: string
  date: string
  hit_requests: number
  hit_req_pct: number
  miss_requests: number
  total_requests: number
  hits_data: string
  hits_data_pct: number
  misses_data: string
  total_data: string
}

export interface AptCacheStats extends AptCacheServer {
  ok: boolean
  error?: string
  data_fetched_startup: string
  data_fetched_recent: string
  data_served_startup: string
  data_served_recent: string
  daily: AptCacheDailyRow[]
}

export interface TailscaleStatus {
  available: boolean
  backend_state?: string
  tailscale_ips?: string[]
  ipv4?: string | null
  ipv6?: string | null
  hostname?: string
  dns_name?: string
  online?: boolean
}
