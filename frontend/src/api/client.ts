import type {
  FleetOverview, NotificationConfig, PackageInfo,
  ScheduleConfig, Server, ServerGroup, UpdateHistory, User,
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
  create: (data: { name: string; hostname: string; username: string; ssh_port?: number; group_id?: number }) =>
    post<Server>('/api/servers', data),
  update: (id: number, data: Partial<Server>) => put<Server>(`/api/servers/${id}`, data),
  remove: (id: number) => del(`/api/servers/${id}`),
  test: (id: number) => post<{ success: boolean; detail: string }>(`/api/servers/${id}/test`),
  check: (id: number) => post<{ status: string; packages_available: number }>(`/api/servers/${id}/check`),
  checkAll: () => post<{ checked: number }>('/api/servers/check-all'),
  upgrade: (id: number, action: string, allow_phased: boolean) =>
    post(`/api/servers/${id}/upgrade`, { action, allow_phased }),
  upgradeAll: (action: string, allow_phased: boolean) =>
    post('/api/servers/upgrade-all', { action, allow_phased }),
  packages: (id: number) =>
    get<{ packages: PackageInfo[]; held: string[]; checked_at: string }>(`/api/servers/${id}/packages`),
  history: (id: number, page = 1) =>
    get<{ total: number; page: number; items: UpdateHistory[] }>(`/api/servers/${id}/history?page=${page}`),
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
// Stats
// ---------------------------------------------------------------------------

export const stats = {
  overview: () => get<FleetOverview>('/api/stats/overview'),
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
// WebSocket helper
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
