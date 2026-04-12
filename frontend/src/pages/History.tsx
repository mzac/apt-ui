import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { stats as statsApi, servers as serversApi, notifications as notifApi } from '@/api/client'
import type { UpdateHistory, Server, NotificationLog } from '@/types'

type HistoryItem = UpdateHistory & { server_name: string }

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function duration(item: HistoryItem): string {
  if (!item.completed_at) return '—'
  const secs = Math.round((new Date(item.completed_at).getTime() - new Date(item.started_at).getTime()) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function UpdateHistory() {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [serverList, setServerList] = useState<Server[]>([])
  const [filterServerId, setFilterServerId] = useState<number | undefined>(undefined)
  const [filterStatus, setFilterStatus] = useState<string>('')

  const perPage = 50

  useEffect(() => {
    serversApi.list().then(setServerList).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    statsApi.globalHistory(page, filterServerId, filterStatus || undefined).then(res => {
      setItems(res.items)
      setTotal(res.total)
    }).finally(() => setLoading(false))
  }, [page, filterServerId, filterStatus])

  function handleFilterChange() {
    setPage(1)
    setExpanded(null)
  }

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
          onChange={e => { setFilterServerId(e.target.value ? parseInt(e.target.value) : undefined); handleFilterChange() }}
        >
          <option value="">All servers</option>
          {serverList.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select
          className="input w-36 text-sm"
          value={filterStatus}
          onChange={e => { setFilterStatus(e.target.value); handleFilterChange() }}
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="running">Running</option>
        </select>
        {(filterServerId || filterStatus) && (
          <button
            className="btn-secondary text-xs"
            onClick={() => { setFilterServerId(undefined); setFilterStatus(''); setPage(1) }}
          >
            Clear filters
          </button>
        )}
      </div>

      {loading ? (
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
                <>
                  <tr
                    key={item.id}
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
                    <tr key={`${item.id}-detail`} className="border-b border-border bg-bg">
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
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="btn-secondary text-xs"
          >
            ← Prev
          </button>
          <span className="text-sm text-text-muted font-mono">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
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
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const limit = 50

  useEffect(() => {
    setLoading(true)
    notifApi.history(page, limit)
      .then(r => { setItems(r.items); setTotal(r.total) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [page])

  function relTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime()
    const s = Math.floor(diff / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return new Date(iso).toLocaleDateString()
  }

  const channelBadge = (ch: string) => {
    const map: Record<string, string> = { email: 'text-blue', telegram: 'text-cyan', webhook: 'text-purple' }
    return <span className={`text-[10px] font-mono uppercase tracking-wide ${map[ch] ?? 'text-text-muted'}`}>{ch}</span>
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted font-mono">{total} total entries</span>
      </div>

      {loading ? (
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
                    <td className="px-3 py-2 text-text-muted whitespace-nowrap" title={item.sent_at}>{relTime(item.sent_at)}</td>
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
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn-secondary text-xs">← Prev</button>
              <span className="text-sm text-text-muted font-mono">Page {page} of {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="btn-secondary text-xs">Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const TABS = ['Upgrade History', 'Notification History'] as const
type Tab = typeof TABS[number]

export default function History() {
  const [tab, setTab] = useState<Tab>('Upgrade History')

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-mono text-text-primary">History</h1>

      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
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
    </div>
  )
}
