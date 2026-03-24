import type {
  CheckAllProgress, FleetOverview, NotificationConfig, PackageInfo,
  PackageSearchResult, ScheduleConfig, Server, ServerGroup, Tag, Template,
  TemplatePackage, UpdateHistory, User,
} from '@/types'

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

export const auth = {
  login: (username: string, password: string) =>
    post<User>('/api/auth/login', { username, password }),
  logout: () => post('/api/auth/logout'),
  me: () => get<User>('/api/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    put('/api/auth/password', { current_password, new_password }),
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
  }) => post<Server>('/api/servers', data),
  update: (id: number, data: Partial<Server> & {
    tag_ids?: number[]
    tag_names?: string[]
    group_ids?: number[]
    ssh_private_key?: string
  }) => put<Server>(`/api/servers/${id}`, data),
  clearSshKey: (id: number) => del(`/api/servers/${id}/ssh-key`),
  remove: (id: number) => del(`/api/servers/${id}`),
  reboot: (id: number) => post<{ success: boolean; detail: string }>(`/api/servers/${id}/reboot`),
  test: (id: number) => post<{ success: boolean; detail: string }>(`/api/servers/${id}/test`),
  reachability: () => get<Record<string, boolean>>('/api/servers/reachability'),
  check: (id: number) => post<{ status: string; packages_available: number }>(`/api/servers/${id}/check`),
  checkAll: () => post<{ detail: string; total: number }>('/api/servers/check-all'),
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
  globalHistory: (page = 1) =>
    get<{ total: number; page: number; per_page: number; items: (UpdateHistory & { server_name: string })[] }>(`/api/history?page=${page}`),
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export const scheduler = {
  status: () => get<ScheduleConfig>('/api/scheduler/status'),
  update: (data: Partial<ScheduleConfig>) => put<ScheduleConfig>('/api/scheduler/config', data),
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
  params: { action: string; allow_phased: boolean },
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
