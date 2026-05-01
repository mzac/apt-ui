import type {
  CheckAllProgress, FleetOverview, NotificationConfig, NotificationLog, PackageInfo,
  PackageSearchResult, ScheduleConfig, Server, ServerGroup, Tag, Template,
  TemplatePackage, UpdateHistory, User,
} from '@/types'

export interface AptRepoFile {
  path: string
  content: string
  format: 'one-line' | 'deb822'
  deletable: boolean
}

export interface DpkgLogEntry {
  timestamp: string
  action: 'install' | 'upgrade' | 'remove' | 'purge'
  package: string
  arch: string
  old_version: string
  new_version: string
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })

  if (res.status === 401) {
    // Redirect to login unless already there
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login?expired=1'
    }
    throw new ApiError(401, 'Session expired')
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      detail = body.detail || detail
    } catch {}
    throw new ApiError(res.status, detail)
  }

  if (res.status === 204) return undefined as unknown as T
  return res.json()
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined })
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface ApiTokenSummary {
  id: number
  name: string
  prefix: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

export interface UserSummary {
  id: number
  username: string
  is_admin: boolean
  created_at: string
  last_login: string | null
}

export const auth = {
  login: (username: string, password: string, totp_code?: string) =>
    post<User>('/api/auth/login', { username, password, totp_code }),
  logout: () => post('/api/auth/logout'),
  me: () => get<User>('/api/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    put('/api/auth/password', { current_password, new_password }),
  listTokens: () => get<ApiTokenSummary[]>('/api/auth/tokens'),
  createToken: (name: string) =>
    post<ApiTokenSummary & { token: string }>('/api/auth/tokens', { name }),
  revokeToken: (id: number) => del(`/api/auth/tokens/${id}`),
  // 2FA — issue #18
  totpSetup: () => post<{ secret: string; uri: string; qr_svg: string }>('/api/auth/2fa/setup'),
  totpVerify: (code: string) => post<{ detail: string }>('/api/auth/2fa/verify', { code }),
  totpDisable: (password: string) => post<{ detail: string }>('/api/auth/2fa/disable', { password }),
  totpStatus: () => get<{ enabled: boolean }>('/api/auth/2fa/status'),
  // User management (admin only) — issue #39
  listUsers: () => get<UserSummary[]>('/api/auth/users'),
  createUser: (data: { username: string; password: string; is_admin: boolean }) =>
    post<UserSummary>('/api/auth/users', data),
  updateUser: (id: number, data: { is_admin?: boolean; password?: string }) =>
    put<UserSummary>(`/api/auth/users/${id}`, data),
  deleteUser: (id: number) => del(`/api/auth/users/${id}`),
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export const servers = {
  list: (params?: { group_id?: number; status?: string }) => {
    const q = new URLSearchParams()
    if (params?.group_id != null) q.set('group_id', String(params.group_id))
    if (params?.status) q.set('status', params.status)
    return get<Server[]>(`/api/servers${q.toString() ? '?' + q : ''}`)
  },
  create: (data: {
    name: string
    hostname: string
    username: string
    ssh_port?: number
    group_id?: number
    group_ids?: number[]
    tag_ids?: number[]
    tag_names?: string[]
    ssh_private_key?: string
    notes?: string
  }) => post<Server>('/api/servers', data),
  update: (id: number, data: Partial<Server> & {
    tag_ids?: number[]
    tag_names?: string[]
    group_ids?: number[]
    ssh_private_key?: string
    notes?: string
  }) => put<Server>(`/api/servers/${id}`, data),
  clearSshKey: (id: number) => del(`/api/servers/${id}/ssh-key`),
  generateSshKey: () => post<{ private_key: string; public_key: string }>('/api/servers/generate-ssh-key', {}),
  remove: (id: number) => del(`/api/servers/${id}`),
  reboot: (id: number) => post<{ success: boolean; detail: string }>(`/api/servers/${id}/reboot`),
  test: (id: number) => post<{ success: boolean; detail: string }>(`/api/servers/${id}/test`),
  reachability: () => get<Record<string, boolean>>('/api/servers/reachability'),
  check: (id: number) => post<{ status: string; packages_available: number }>(`/api/servers/${id}/check`),
  checkAll: () => post<{ detail: string; total: number }>('/api/servers/check-all'),
  refreshAll: () => post<{ detail: string; total: number }>('/api/servers/refresh-all'),
  refresh: (id: number) => post<{ status: string; packages_available: number }>(`/api/servers/${id}/refresh`, {}),
  checkProgress: () => get<CheckAllProgress>('/api/servers/check-all/progress'),
  upgrade: (id: number, action: string, allow_phased: boolean) =>
    post(`/api/servers/${id}/upgrade`, { action, allow_phased }),
  upgradeAll: (action: string, allow_phased: boolean) =>
    post('/api/servers/upgrade-all', { action, allow_phased }),
  packages: (id: number) =>
    get<{ packages: PackageInfo[]; held: string[]; autoremove: string[]; checked_at: string }>(`/api/servers/${id}/packages`),
  packageSearch: (id: number, q: string) =>
    get<PackageSearchResult[]>(`/api/servers/${id}/packages/search?q=${encodeURIComponent(q)}`),
  history: (id: number, page = 1) =>
    get<{ total: number; page: number; items: UpdateHistory[] }>(`/api/servers/${id}/history?page=${page}`),
  setAutoSecurityUpdates: (id: number, enable: boolean) =>
    post<{ success: boolean; auto_security_updates: string }>(`/api/servers/${id}/auto-security-updates`, { enable }),
  dpkgLog: (id: number, params?: { package?: string; action?: string; days?: number; limit?: number; offset?: number }) => {
    const q = new URLSearchParams()
    if (params?.package) q.set('package', params.package)
    if (params?.action) q.set('action', params.action)
    if (params?.days != null) q.set('days', String(params.days))
    if (params?.limit != null) q.set('limit', String(params.limit))
    if (params?.offset != null) q.set('offset', String(params.offset))
    return get<{ total: number; offset: number; limit: number; items: DpkgLogEntry[] }>(
      `/api/servers/${id}/dpkg-log${q.toString() ? '?' + q : ''}`
    )
  },
  validateDebUrl: (id: number, url: string) =>
    post<{ valid: boolean; filename?: string; content_length?: number | null; error?: string }>(
      `/api/servers/${id}/validate-deb-url`, { url }
    ),
  aptRepos: (id: number) =>
    get<{ files: AptRepoFile[] }>(`/api/servers/${id}/apt-repos`),
  saveAptRepo: (id: number, path: string, content: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/apt-repos`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  deleteAptRepo: (id: number, path: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/apt-repos`, {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    }),
  compare: (server_ids: number[]) =>
    post<{
      servers: { id: number; name: string; hostname: string }[]
      packages: Record<string, Record<string, string | null>>
      errors: Record<string, string>
    }>('/api/servers/compare', { server_ids }),
  searchPackage: (name: string, mode: 'exact' | 'contains' | 'starts-with' | 'ends-with' | 'regex' = 'contains') =>
    post<{
      servers: { id: number; name: string; hostname: string }[]
      matches: Record<string, Record<string, string>>  // pkg → { server_id: version }
      errors: Record<string, string>
    }>('/api/servers/search-package', { name, mode }),
  health: (id: number) =>
    get<{
      failed_services: { unit: string; load: string; active: string; sub: string; description: string }[]
      recent_errors: string[]
      reboots: string[]
      collected_at: string
    }>(`/api/servers/${id}/health`),
  restartService: (id: number, unit: string) =>
    post<{ success: boolean; unit: string; stdout: string; stderr: string }>(
      `/api/servers/${id}/restart-service`, { unit }
    ),
  holdPackage: (id: number, pkg: string, hold: boolean) =>
    post<{ success: boolean; package: string; hold: boolean; stdout: string; stderr: string }>(
      `/api/servers/${id}/hold-package`, { package: pkg, hold }
    ),
  bulkHold: (server_ids: number[], pkg: string, hold: boolean) =>
    post<{ package: string; hold: boolean; results: Record<string, { success: boolean; stdout: string; stderr: string }> }>(
      '/api/servers/bulk-hold', { server_ids, package: pkg, hold }
    ),
  uploadDeb: (id: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return fetch(`/api/servers/${id}/upload-deb`, {
      method: 'POST', credentials: 'include', body: form,
    }).then(async r => {
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      return r.json() as Promise<{ remote_path: string; filename: string; size: number }>
    })
  },
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const groups = {
  list: () => get<ServerGroup[]>('/api/groups'),
  create: (data: { name: string; color?: string; sort_order?: number }) =>
    post<ServerGroup>('/api/groups', data),
  update: (id: number, data: Partial<ServerGroup>) => put<ServerGroup>(`/api/groups/${id}`, data),
  remove: (id: number) => del(`/api/groups/${id}`),
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const tags = {
  list: () => get<Tag[]>('/api/tags'),
  create: (data: { name: string; color?: string; sort_order?: number }) =>
    post<Tag>('/api/tags', data),
  update: (id: number, data: Partial<Tag>) => put<Tag>(`/api/tags/${id}`, data),
  remove: (id: number) => del(`/api/tags/${id}`),
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const templates = {
  list: () => get<Template[]>('/api/templates'),
  create: (data: { name: string; description?: string; packages?: { package_name: string; notes?: string }[] }) =>
    post<Template>('/api/templates', data),
  update: (id: number, data: { name?: string; description?: string }) =>
    put<Template>(`/api/templates/${id}`, data),
  remove: (id: number) => del(`/api/templates/${id}`),
  addPackage: (id: number, data: { package_name: string; notes?: string }) =>
    post<TemplatePackage>(`/api/templates/${id}/packages`, data),
  removePackage: (templateId: number, pkgId: number) =>
    del(`/api/templates/${templateId}/packages/${pkgId}`),
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export const stats = {
  overview: () => get<FleetOverview>('/api/stats/overview'),
  globalHistory: (page = 1, serverId?: number, status?: string) => {
    const params = new URLSearchParams({ page: String(page) })
    if (serverId !== undefined) params.set('server_id', String(serverId))
    if (status) params.set('status', status)
    return get<{ total: number; page: number; per_page: number; items: (UpdateHistory & { server_name: string })[] }>(`/api/history?${params}`)
  },
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export const scheduler = {
  status: () => get<ScheduleConfig>('/api/scheduler/status'),
  update: (data: Partial<ScheduleConfig>) => put<ScheduleConfig>('/api/scheduler/config', data),
}

export interface MaintenanceWindow {
  id: number
  server_id: number | null   // null = global
  name: string
  start_minutes: number       // 0..1439
  end_minutes: number         // 0..1439
  days_of_week: number        // bitmask: bit 0=Mon ... bit 6=Sun
  enabled: boolean
  created_at: string
}

export const maintenance = {
  list: () => get<MaintenanceWindow[]>('/api/maintenance'),
  create: (data: Omit<MaintenanceWindow, 'id' | 'created_at'>) =>
    post<MaintenanceWindow>('/api/maintenance', data),
  update: (id: number, data: Partial<Omit<MaintenanceWindow, 'id' | 'created_at'>>) =>
    put<MaintenanceWindow>(`/api/maintenance/${id}`, data),
  remove: (id: number) => del(`/api/maintenance/${id}`),
  active: () => get<{ blocked: Record<string, { window_id: number; name: string }>; checked_at: string }>('/api/maintenance/active'),
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = {
  getConfig: () => get<NotificationConfig>('/api/notifications/config'),
  updateConfig: (data: Partial<NotificationConfig>) =>
    put<NotificationConfig>('/api/notifications/config', data),
  testEmail: () => post('/api/notifications/test/email'),
  testTelegram: () => post('/api/notifications/test/telegram'),
  detectChatId: () => get<{ chats: { id: number; title: string }[] }>('/api/notifications/telegram/detect-chat-id'),
  history: (page = 1, limit = 50) =>
    get<{ total: number; page: number; limit: number; items: NotificationLog[] }>(
      `/api/notifications/history?page=${page}&limit=${limit}`
    ),
}

// ---------------------------------------------------------------------------
// Config export / import
// ---------------------------------------------------------------------------

export const config = {
  export: () => get<Record<string, unknown>>('/api/config/export'),
  import: (data: Record<string, unknown>, opts?: { overwrite_servers?: boolean; overwrite_schedule?: boolean; overwrite_notifications?: boolean }) =>
    post<{ imported: Record<string, unknown> }>('/api/config/import', { data, ...opts }),
  features: () => get<{ enable_terminal: boolean }>('/api/config/features'),
  exportCsv: () => fetch('/api/config/servers/csv', { credentials: 'include' }),
  importCsv: (file: File, overwrite = false) => {
    const form = new FormData()
    form.append('file', file)
    return fetch(`/api/config/servers/csv?overwrite=${overwrite}`, {
      method: 'POST', credentials: 'include', body: form,
    }).then(r => r.json() as Promise<{ added: number; skipped: number }>)
  },
}

export const tailscale = {
  status: () => get<import('@/types').TailscaleStatus>('/api/tailscale/status'),
}

export interface ReleaseCheckResult {
  current: string
  latest: string | null
  url?: string
  published_at?: string | null
  update_available: boolean
  error: string | null
}

export const releaseCheck = {
  status: () => get<ReleaseCheckResult>('/api/release-check'),
}

export interface UpgradeHook {
  id: number
  server_id: number | null  // null = global
  name: string
  phase: 'pre' | 'post'
  command: string
  sort_order: number
  enabled: boolean
  created_at: string
}

export const hooks = {
  list: () => get<UpgradeHook[]>('/api/hooks'),
  create: (data: Omit<UpgradeHook, 'id' | 'created_at'>) =>
    post<UpgradeHook>('/api/hooks', data),
  update: (id: number, data: Partial<Omit<UpgradeHook, 'id' | 'created_at'>>) =>
    put<UpgradeHook>(`/api/hooks/${id}`, data),
  remove: (id: number) => del(`/api/hooks/${id}`),
}

export interface SshAuditEntry {
  id: number
  server_id: number
  server_name: string
  started_at: string
  duration_ms: number | null
  initiated_by: string
  command: string
  exit_code: number | null
  output_excerpt: string | null
}

export const reports = {
  patchCoverage: () => get<{
    generated_at: string
    total_enabled_servers: number
    summary: { checked_in_24h: number; checked_in_7d: number; checked_in_30d: number; pct_24h: number; pct_7d: number; pct_30d: number }
    servers: { server: string; hostname: string; last_check: string | null; in_24h: boolean; in_7d: boolean; in_30d: boolean }[]
  }>('/api/reports/patch-coverage'),
  upgradeSuccessRate: (days = 30) => get<{
    generated_at: string
    window_days: number
    summary: { total_success: number; total_error: number; overall_rate: number | null }
    servers: { server: string; hostname: string; success: number; error: number; running: number; success_rate: number | null }[]
  }>(`/api/reports/upgrade-success-rate?days=${days}`),
  securitySla: (slaDays = 7, windowDays = 90) => get<{
    generated_at: string
    sla_days: number
    window_days: number
    summary: { in_sla: number; out_of_sla: number; no_security_seen: number; pct_in_sla: number | null }
    servers: { server: string; hostname: string; first_security_seen: string | null; cleared_at: string | null; days_to_clear: number | null; in_sla: boolean | null }[]
  }>(`/api/reports/security-sla?sla_days=${slaDays}&window_days=${windowDays}`),
}

export const sshAudit = {
  list: (params?: { server_id?: number; page?: number; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.server_id != null) q.set('server_id', String(params.server_id))
    if (params?.page) q.set('page', String(params.page))
    if (params?.limit) q.set('limit', String(params.limit))
    return get<{ total: number; page: number; limit: number; items: SshAuditEntry[] }>(
      `/api/servers/audit-log${q.toString() ? '?' + q : ''}`
    )
  },
}

export const aptcache = {
  list:       () => get<import('@/types').AptCacheServer[]>('/api/aptcache'),
  add:        (data: { label: string; host: string; port: number }) =>
                post<import('@/types').AptCacheServer>('/api/aptcache', data),
  update:     (id: number, data: Partial<{ label: string; host: string; port: number; enabled: boolean }>) =>
                put<import('@/types').AptCacheServer>(`/api/aptcache/${id}`, data),
  remove:     (id: number) => del(`/api/aptcache/${id}`),
  stats:      (id: number) => get<import('@/types').AptCacheStats>(`/api/aptcache/${id}/stats`),
  allStats:   () => get<import('@/types').AptCacheStats[]>('/api/aptcache/stats/all'),
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

export function createUpgradeWebSocket(
  serverId: number | 'all',
  params: { action: string; allow_phased: boolean; reboot_if_required?: boolean },
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = serverId === 'all'
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/upgrade-all`
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/upgrade/${serverId}`

  const ws = new WebSocket(url)

  ws.onopen = () => {
    ws.send(JSON.stringify(params))
  }

  ws.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data))
    } catch {}
  }

  ws.onclose = () => onClose?.()

  return ws
}

export function createSelectiveUpgradeWebSocket(
  serverId: number,
  params: { packages: string[]; allow_phased: boolean },
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/upgrade-selective/${serverId}`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify(params)) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createAptUpdateWebSocket(
  serverId: number,
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/apt-update/${serverId}`
  const ws = new WebSocket(url)
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createAutoremoveWebSocket(
  serverId: number,
  params: { packages: string[] | null },
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/autoremove/${serverId}`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify(params)) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createAutoremoveAllWebSocket(
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/autoremove-all`
  const ws = new WebSocket(url)
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createRebootAllWebSocket(
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
  params?: { server_ids?: number[] },
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/reboot-all`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify(params ?? {})) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createInstallWebSocket(
  serverId: number,
  packages: string[],
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/install/${serverId}`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify({ packages })) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createDryRunWebSocket(
  serverId: number,
  params: { action: string; allow_phased: boolean },
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/dry-run/${serverId}`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify(params)) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createEepromUpdateWebSocket(
  serverId: number,
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/eeprom-update/${serverId}`
  const ws = new WebSocket(url)
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createPveUpgradeWebSocket(
  serverId: number,
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/pveupgrade/${serverId}`
  const ws = new WebSocket(url)
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createAptProxyWebSocket(
  serverId: number,
  params: { enable: boolean; mode?: 'manual' | 'auto'; proxy_url?: string },
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/apt-proxy/${serverId}`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify(params)) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createAutoSecurityUpdatesWebSocket(
  serverId: number,
  params: { enable: boolean },
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/auto-security-updates/${serverId}`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify(params)) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createTemplateApplyWebSocket(
  templateId: number,
  serverIds: number[],
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/template-apply/${templateId}`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify({ server_ids: serverIds })) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createInstallDebWebSocket(
  serverId: number,
  params: { source: 'url'; url: string } | { source: 'remote'; path: string },
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/install-deb/${serverId}`
  const ws = new WebSocket(url)
  ws.onopen = () => { ws.send(JSON.stringify(params)) }
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}

export function createAptReposTestWebSocket(
  serverId: number,
  onMessage: (msg: Record<string, unknown>) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/apt-repos-test/${serverId}`
  const ws = new WebSocket(url)
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)) } catch {} }
  ws.onclose = () => onClose?.()
  return ws
}
