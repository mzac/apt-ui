import { Fragment, useState, useEffect, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { stats as statsApi, servers as serversApi, notifications as notifApi, sshAudit as sshAuditApi, auth as authApi } from '@/api/client'
import type { UpdateHistory, Server, NotificationLog } from '@/types'
import { useAuthStore } from '@/hooks/useAuth'
// Shared parsers: the backend serializes naive UTC, so `new Date(iso)` was read
// as local time here — which printed literal negative ages ("-14341s ago") and
// clamped hours-old events to "just now".
import { formatDateTime, parseServerDate, relativeTime } from '@/utils/datetime'

type HistoryItem = UpdateHistory & { server_name: string }

function duration(item: HistoryItem): string {
  const completed = parseServerDate(item.completed_at)
  const started = parseServerDate(item.started_at)
  if (!completed || !started) return '—'
  const secs = Math.round((completed.getTime() - started.getTime()) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/** Inline error card with a retry — used by every tab's loader. */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card border-red/40 bg-red/5 p-3 flex items-center gap-3">
      <span className="text-sm text-red font-mono flex-1 truncate" title={message}>{message}</span>
      <button onClick={onRetry} className="btn-secondary text-xs shrink-0">Retry</button>
    </div>
  )
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

// ---------------------------------------------------------------------------
// Deep-linkable audit state (issue #62)
//
// Sub-tab, per-tab filters and page number all live in the query string so an
// audit view can be bookmarked or shared. Each tab's params are prefixed
// (u_/n_/s_/a_) so switching tabs never lets one tab's filter bleed into
// another's same-named field. `patch` always uses `replace` — otherwise every
// filter tweak or page flip would push a new history entry and the Back
// button would have to be clicked through each one instead of leaving History
// entirely, one click back.
// ---------------------------------------------------------------------------
function useQueryPatch() {
  const [searchParams, setSearchParams] = useSearchParams()
  const patch = useCallback((updates: Record<string, string | undefined>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(updates)) {
        if (!v) next.delete(k)
        else next.set(k, v)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])
  return [searchParams, patch] as const
}

function UpdateHistory() {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [serverList, setServerList] = useState<Server[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [searchParams, patchParams] = useQueryPatch()

  const filterServerId = searchParams.get('u_server') ? parseInt(searchParams.get('u_server')!) : undefined
  const filterStatus = searchParams.get('u_status') ?? ''
  const page = parseInt(searchParams.get('u_page') ?? '1') || 1

  const perPage = 50

  useEffect(() => {
    serversApi.list().then(setServerList).catch(() => {})
  }, [])

  // `cancelled` guards against an out-of-order response: flipping pages or
  // filters quickly could otherwise paint an older page's rows under the newly
  // selected filters.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    statsApi.globalHistory(page, filterServerId, filterStatus || undefined)
      .then(res => {
        if (cancelled) return
        setItems(res.items)
        setTotal(res.total)
      })
      .catch(e => {
        if (cancelled) return
        setItems([])
        setTotal(0)
        setError(errMsg(e, 'Failed to load upgrade history'))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [page, filterServerId, filterStatus, reload])

  const totalPages = Math.ceil(total / perPage)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted font-mono">{total} total entries</span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          className="input w-48 text-sm"
          value={filterServerId ?? ''}
          onChange={e => { patchParams({ u_server: e.target.value || undefined, u_page: undefined }); setExpanded(null) }}
        >
          <option value="">All servers</option>
          {serverList.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select
          className="input w-36 text-sm"
          value={filterStatus}
          onChange={e => { patchParams({ u_status: e.target.value || undefined, u_page: undefined }); setExpanded(null) }}
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="running">Running</option>
        </select>
        {(filterServerId || filterStatus) && (
          <button
            className="btn-secondary text-xs"
            onClick={() => patchParams({ u_server: undefined, u_status: undefined, u_page: undefined })}
          >
            Clear filters
          </button>
        )}
      </div>

      {error ? (
        <LoadError message={error} onRetry={() => setReload(n => n + 1)} />
      ) : loading ? (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">No upgrade history found.</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="text-left px-3 py-2">Server</th>
                <th className="text-left px-3 py-2">Action</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Packages</th>
                <th className="text-left px-3 py-2">Duration</th>
                <th className="text-left px-3 py-2">Started</th>
                <th className="text-left px-3 py-2">By</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <Fragment key={item.id}>
                  <tr
                    className="border-b border-border/50 hover:bg-surface/50 cursor-pointer"
                    onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                  >
                    <td className="px-3 py-2">
                      <Link
                        to={`/servers/${item.server_id}`}
                        className="text-cyan hover:underline"
                        onClick={e => e.stopPropagation()}
                      >
                        {item.server_name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-text-muted">{item.action}</td>
                    <td className="px-3 py-2">
                      <span className={
                        item.status === 'success' ? 'text-green' :
                        item.status === 'error' ? 'text-red' :
                        item.status === 'running' ? 'text-cyan' : 'text-text-muted'
                      }>
                        {item.status === 'success' ? '✓' : item.status === 'error' ? '✗' : '⚙'} {item.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-text-muted">
                      {item.packages_upgraded ? item.packages_upgraded.length : '—'}
                    </td>
                    <td className="px-3 py-2 text-text-muted">{duration(item)}</td>
                    <td className="px-3 py-2 text-text-muted" title={item.started_at}>
                      {relativeTime(item.started_at)}
                    </td>
                    <td className="px-3 py-2 text-text-muted">{item.initiated_by}</td>
                    <td className="px-3 py-2 text-text-muted">{expanded === item.id ? '▲' : '▼'}</td>
                  </tr>
                  {expanded === item.id && (
                    <tr className="border-b border-border bg-bg">
                      <td colSpan={8} className="px-3 py-3 space-y-3">
                        {item.packages_upgraded && item.packages_upgraded.length > 0 && (
                          <div>
                            <div className="text-text-muted mb-1">Packages upgraded:</div>
                            <div className="flex flex-wrap gap-1">
                              {item.packages_upgraded.map((p, i) => (
                                <span key={i} className="bg-surface px-1.5 py-0.5 rounded text-text-primary border border-border">
                                  {p.name}{p.from_version ? `: ${p.from_version} → ${p.to_version}` : ''}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {item.log_output && (
                          <div>
                            <div className="text-text-muted mb-1">Log output:</div>
                            <pre className="bg-bg border border-border rounded p-2 text-xs text-text-primary overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">{item.log_output}</pre>
                          </div>
                        )}
                        {!item.packages_upgraded?.length && !item.log_output && (
                          <div className="text-text-muted">No details available.</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => patchParams({ u_page: page - 1 <= 1 ? undefined : String(page - 1) })}
            disabled={page === 1}
            className="btn-secondary text-xs"
          >
            ← Prev
          </button>
          <span className="text-sm text-text-muted font-mono">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => patchParams({ u_page: String(Math.min(totalPages, page + 1)) })}
            disabled={page === totalPages}
            className="btn-secondary text-xs"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

function NotificationHistory() {
  const [items, setItems] = useState<NotificationLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [searchParams, patchParams] = useQueryPatch()
  const page = parseInt(searchParams.get('n_page') ?? '1') || 1
  const limit = 50

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    notifApi.history(page, limit)
      .then(r => { if (cancelled) return; setItems(r.items); setTotal(r.total) })
      .catch(e => {
        if (cancelled) return
        setItems([])
        setTotal(0)
        setError(errMsg(e, 'Failed to load notification history'))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [page, reload])

  const channelBadge = (ch: string) => {
    const map: Record<string, string> = { email: 'text-blue', telegram: 'text-cyan', webhook: 'text-purple', slack: 'text-amber' }
    return <span className={`text-[10px] font-mono uppercase tracking-wide ${map[ch] ?? 'text-text-muted'}`}>{ch}</span>
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted font-mono">{total} total entries</span>
      </div>

      {error ? (
        <LoadError message={error} onRetry={() => setReload(n => n + 1)} />
      ) : loading ? (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">No notifications sent yet.</div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-text-muted text-left">
                  <th className="px-3 py-2 font-normal">Time</th>
                  <th className="px-3 py-2 font-normal">Channel</th>
                  <th className="px-3 py-2 font-normal">Event</th>
                  <th className="px-3 py-2 font-normal">Summary</th>
                  <th className="px-3 py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {items.map(item => (
                  <tr key={item.id} className="hover:bg-surface/50">
                    <td className="px-3 py-2 text-text-muted whitespace-nowrap" title={formatDateTime(item.sent_at)}>{relativeTime(item.sent_at)}</td>
                    <td className="px-3 py-2">{channelBadge(item.channel)}</td>
                    <td className="px-3 py-2 text-text-muted whitespace-nowrap">{item.event_type.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 text-text-primary max-w-xs truncate" title={item.summary}>{item.summary}</td>
                    <td className="px-3 py-2">
                      {item.success
                        ? <span className="text-green">✓</span>
                        : <span className="text-red" title={item.error_message ?? undefined}>✗</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button disabled={page <= 1} onClick={() => patchParams({ n_page: page - 1 <= 1 ? undefined : String(page - 1) })} className="btn-secondary text-xs">← Prev</button>
              <span className="text-sm text-text-muted font-mono">Page {page} of {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => patchParams({ n_page: String(page + 1) })} className="btn-secondary text-xs">Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const ALL_TABS = ['Upgrade History', 'Notification History', 'SSH Audit Log', 'Auth Events'] as const
type Tab = typeof ALL_TABS[number]

// Short, URL-friendly slugs for the `tab` query param — kept distinct from the
// display labels so the URL doesn't need to encode spaces.
const TAB_SLUGS: Record<Tab, string> = {
  'Upgrade History': 'upgrades',
  'Notification History': 'notifications',
  'SSH Audit Log': 'ssh',
  'Auth Events': 'auth',
}
const SLUG_TO_TAB: Record<string, Tab> = {}
for (const t of ALL_TABS) SLUG_TO_TAB[TAB_SLUGS[t]] = t
const DEFAULT_TAB: Tab = 'Upgrade History'

export default function History() {
  const { user } = useAuthStore()
  const tabs = ALL_TABS.filter(t => t !== 'Auth Events' || user?.is_admin)  // auth log is admin-only

  // The active tab is driven by ?tab=<slug> (see Settings.tsx for the pattern this
  // follows, including the comment there about a navigate() to the same route
  // leaving the tab stuck — the fix is to re-derive the tab from the URL on every
  // render rather than mirroring it into local state that only updates on mount).
  // History has no unsaved-edit state to guard, so unlike Settings there's no
  // confirm-before-switch dance needed — just read straight from the URL.
  const [searchParams, setSearchParams] = useSearchParams()
  const slug = searchParams.get('tab')
  const urlTab = (slug && SLUG_TO_TAB[slug]) || DEFAULT_TAB
  const tab: Tab = tabs.includes(urlTab) ? urlTab : DEFAULT_TAB

  function selectTab(t: Tab) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (t === DEFAULT_TAB) next.delete('tab')
      else next.set('tab', TAB_SLUGS[t])
      return next
    }, { replace: true })
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-mono text-text-primary">History</h1>

      <div className="flex gap-1 border-b border-border">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => selectTab(t)}
            className={`px-4 py-2 text-sm transition-colors -mb-px border-b-2 ${
              tab === t
                ? 'border-green text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Upgrade History' && <UpdateHistory />}
      {tab === 'Notification History' && <NotificationHistory />}
      {tab === 'SSH Audit Log' && <SshAuditHistory />}
      {tab === 'Auth Events' && <AuthEventsHistory />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SSH Audit Log (issue #30)
// ---------------------------------------------------------------------------

function SshAuditHistory() {
  const [items, setItems] = useState<import('@/api/client').SshAuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [serverList, setServerList] = useState<Server[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [searchParams, patchParams] = useQueryPatch()
  const filterServerId = searchParams.get('s_server') ? parseInt(searchParams.get('s_server')!) : undefined
  const page = parseInt(searchParams.get('s_page') ?? '1') || 1
  const limit = 100

  useEffect(() => {
    serversApi.list().then(setServerList).catch(() => {})
  }, [])

  // `cancelled` guards against an out-of-order response (see UpdateHistory above) —
  // otherwise a slow page N response could land after a faster page N+1 one and
  // paint stale rows under the new page number, or an error could leave the old
  // page's rows on screen with no indication anything failed.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    sshAuditApi.list({ server_id: filterServerId, page, limit })
      .then(r => {
        if (cancelled) return
        setItems(r.items)
        setTotal(r.total)
      })
      .catch(e => {
        if (cancelled) return
        setItems([])
        setTotal(0)
        setError(errMsg(e, 'Failed to load SSH audit log'))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [page, filterServerId, reload])

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted font-mono">{total} entries</span>
        <select
          className="input w-48 text-sm"
          value={filterServerId ?? ''}
          onChange={e => { patchParams({ s_server: e.target.value || undefined, s_page: undefined }); setExpanded(null) }}
        >
          <option value="">All servers</option>
          {serverList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {error ? (
        <LoadError message={error} onRetry={() => setReload(n => n + 1)} />
      ) : loading ? (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">No SSH commands recorded yet.</div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="text-left px-3 py-2 font-normal">When</th>
                  <th className="text-left px-3 py-2 font-normal">Server</th>
                  <th className="text-left px-3 py-2 font-normal">Command</th>
                  <th className="text-left px-3 py-2 font-normal">Exit</th>
                  <th className="text-left px-3 py-2 font-normal">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {items.map(entry => (
                  <Fragment key={entry.id}>
                    <tr
                      className="hover:bg-surface/50 cursor-pointer"
                      onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    >
                      <td className="px-3 py-1.5 text-text-muted whitespace-nowrap" title={formatDateTime(entry.started_at)}>{relativeTime(entry.started_at)}</td>
                      <td className="px-3 py-1.5">
                        <Link to={`/servers/${entry.server_id}`} onClick={e => e.stopPropagation()} className="text-cyan hover:underline">
                          {entry.server_name}
                        </Link>
                      </td>
                      <td className="px-3 py-1.5 text-text-primary truncate max-w-md">{entry.command}</td>
                      <td className="px-3 py-1.5">
                        {entry.exit_code === 0
                          ? <span className="text-green">0</span>
                          : <span className="text-red">{entry.exit_code ?? '?'}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-text-muted">{entry.duration_ms != null ? `${entry.duration_ms} ms` : '—'}</td>
                    </tr>
                    {expanded === entry.id && (
                      <tr className="border-b border-border bg-bg">
                        <td colSpan={5} className="px-3 py-2">
                          {entry.output_excerpt ? (
                            <>
                              <p className="text-text-muted text-[10px] uppercase tracking-wide mb-1">Output (first 4 KB)</p>
                              <pre className="bg-bg/50 rounded p-2 text-[11px] text-text-primary overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto">
                                {entry.output_excerpt}
                              </pre>
                            </>
                          ) : (
                            <p className="text-text-muted text-xs">No output captured.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => patchParams({ s_page: page - 1 <= 1 ? undefined : String(page - 1) })} disabled={page <= 1} className="btn-secondary text-xs">← Prev</button>
              <span className="text-sm text-text-muted font-mono">Page {page} of {totalPages}</span>
              <button onClick={() => patchParams({ s_page: String(Math.min(totalPages, page + 1)) })} disabled={page >= totalPages} className="btn-secondary text-xs">Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Auth event log (issue #62) — admin-only
// ---------------------------------------------------------------------------

const AUTH_EVENT_STYLE: Record<string, string> = {
  login: 'text-green',
  logout: 'text-text-muted',
  login_failed: 'text-amber',
  login_blocked: 'text-red',
  lockout: 'text-red',
  token_created: 'text-cyan',
  token_revoked: 'text-amber',
  '2fa_enabled': 'text-green',
  '2fa_disabled': 'text-amber',
  user_created: 'text-cyan',
  user_updated: 'text-cyan',
  user_deleted: 'text-red',
}

function AuthEventsHistory() {
  const [items, setItems] = useState<import('@/api/client').AuthEvent[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [searchParams, patchParams] = useQueryPatch()
  const page = parseInt(searchParams.get('a_page') ?? '1') || 1
  const limit = 100

  // See UpdateHistory above: `cancelled` avoids an out-of-order response
  // painting stale rows under a since-changed page, and a failed load clears
  // the old rows instead of leaving them displayed under the new page number.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    authApi.events(page, limit)
      .then(r => {
        if (cancelled) return
        setItems(r.items)
        setTotal(r.total)
      })
      .catch(e => {
        if (cancelled) return
        setItems([])
        setTotal(0)
        setError(errMsg(e, 'Failed to load auth events'))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [page, reload])

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-4">
      <span className="text-sm text-text-muted font-mono">{total} events</span>
      {error ? (
        <LoadError message={error} onRetry={() => setReload(n => n + 1)} />
      ) : loading ? (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">No auth events recorded yet.</div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="text-left px-3 py-2 font-normal">When</th>
                  <th className="text-left px-3 py-2 font-normal">Event</th>
                  <th className="text-left px-3 py-2 font-normal">User</th>
                  <th className="text-left px-3 py-2 font-normal">Actor</th>
                  <th className="text-left px-3 py-2 font-normal">IP</th>
                  <th className="text-left px-3 py-2 font-normal">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {items.map(e => (
                  <tr key={e.id} className="hover:bg-surface/50">
                    <td className="px-3 py-1.5 text-text-muted whitespace-nowrap" title={formatDateTime(e.created_at)}>{relativeTime(e.created_at)}</td>
                    <td className={`px-3 py-1.5 ${AUTH_EVENT_STYLE[e.event_type] ?? 'text-text-primary'}`}>{e.event_type}</td>
                    <td className="px-3 py-1.5 text-text-primary">{e.username ?? '—'}</td>
                    <td className="px-3 py-1.5 text-text-muted">{e.actor ?? '—'}</td>
                    <td className="px-3 py-1.5 text-text-muted">{e.ip_address ?? '—'}</td>
                    <td className="px-3 py-1.5 text-text-muted truncate max-w-xs">{e.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => patchParams({ a_page: page - 1 <= 1 ? undefined : String(page - 1) })} disabled={page <= 1} className="btn-secondary text-xs">← Prev</button>
              <span className="text-sm text-text-muted font-mono">Page {page} of {totalPages}</span>
              <button onClick={() => patchParams({ a_page: String(Math.min(totalPages, page + 1)) })} disabled={page >= totalPages} className="btn-secondary text-xs">Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
