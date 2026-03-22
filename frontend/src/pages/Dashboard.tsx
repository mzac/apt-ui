import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { servers as serversApi, groups as groupsApi, stats as statsApi } from '@/api/client'
import type { Server, ServerGroup, FleetOverview, ServerStatus } from '@/types'
import { usePolling } from '@/hooks/usePolling'
import { useAuthStore } from '@/hooks/useAuth'
import StatusDot from '@/components/StatusDot'
import UpgradeAllModal from '@/components/UpgradeAllModal'

function serverStatus(s: Server): ServerStatus {
  if (!s.is_enabled) return 'disabled'
  const c = s.latest_check
  if (!c) return 'unknown'
  if (c.status === 'error') return 'error'
  if (c.packages_available > 0) return 'updates_available'
  return 'up_to_date'
}

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

export default function Dashboard() {
  const { user } = useAuthStore()
  const [serverList, setServerList] = useState<Server[]>([])
  const [groupList, setGroupList] = useState<ServerGroup[]>([])
  const [overview, setOverview] = useState<FleetOverview | null>(null)
  const [activeGroup, setActiveGroup] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'name' | 'updates' | 'status'>('status')
  const [checking, setChecking] = useState<Set<number>>(new Set())
  const [showUpgradeAll, setShowUpgradeAll] = useState(false)
  const [checkingAll, setCheckingAll] = useState(false)

  const isDefaultPassword = user?.is_default_password === true

  const load = useCallback(async () => {
    const [s, g, o] = await Promise.all([
      serversApi.list(),
      groupsApi.list(),
      statsApi.overview(),
    ])
    setServerList(s)
    setGroupList(g)
    setOverview(o)
  }, [])

  usePolling(load, 30_000)

  const filtered = serverList
    .filter(s => activeGroup == null || s.group_id === activeGroup)
    .filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.hostname.includes(search))
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      if (sortBy === 'updates') return (b.latest_check?.packages_available ?? 0) - (a.latest_check?.packages_available ?? 0)
      // status sort: error > updates > unknown > up_to_date > disabled
      const order: Record<ServerStatus, number> = { error: 0, updates_available: 1, unknown: 2, checking: 2, upgrading: 2, up_to_date: 3, disabled: 4 }
      return order[serverStatus(a)] - order[serverStatus(b)]
    })

  async function handleCheck(id: number) {
    setChecking(c => new Set(c).add(id))
    try { await serversApi.check(id); await load() }
    finally { setChecking(c => { const n = new Set(c); n.delete(id); return n }) }
  }

  async function handleCheckAll() {
    setCheckingAll(true)
    try { await serversApi.checkAll(); await load() }
    finally { setCheckingAll(false) }
  }

  const serversWithUpdates = filtered.filter(s => (s.latest_check?.packages_available ?? 0) > 0)

  return (
    <div className="space-y-4">
      {/* Default password warning */}
      {isDefaultPassword && (
        <div className="px-4 py-2 bg-amber/10 border border-amber/30 rounded text-amber text-sm">
          ⚠️ You're using the default password. <Link to="/settings" className="underline">Change it in Settings.</Link>
        </div>
      )}

      {/* Fleet summary */}
      {overview && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {[
            { label: 'Total', value: overview.total_servers, color: 'text-text-primary' },
            { label: 'Up to date', value: overview.up_to_date, color: 'text-green' },
            { label: 'Updates', value: overview.updates_available, color: overview.updates_available > 0 ? 'text-amber' : 'text-text-muted' },
            { label: 'Security', value: overview.security_updates_total, color: overview.security_updates_total > 0 ? 'text-red' : 'text-text-muted' },
            { label: 'Errors', value: overview.errors, color: overview.errors > 0 ? 'text-red' : 'text-text-muted' },
            { label: 'Reboot', value: overview.reboot_required, color: overview.reboot_required > 0 ? 'text-amber' : 'text-text-muted' },
            { label: 'Held pkgs', value: overview.held_packages_total, color: overview.held_packages_total > 0 ? 'text-blue' : 'text-text-muted' },
          ].map(({ label, value, color }) => (
            <div key={label} className="card px-3 py-2 text-center">
              <div className={`text-xl font-mono font-medium ${color}`}>{value}</div>
              <div className="text-xs text-text-muted">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Last check / next check */}
      {overview && (
        <p className="text-xs text-text-muted font-mono">
          Last check: {relativeTime(overview.last_check_time)}
          {overview.next_check_time && ` · Next: ${new Date(overview.next_check_time).toLocaleTimeString()}`}
        </p>
      )}

      {/* Group filter */}
      {groupList.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setActiveGroup(null)}
            className={`badge px-2 py-1 text-xs transition-colors ${activeGroup == null ? 'bg-green/20 text-green border border-green/40' : 'bg-surface-2 text-text-muted border border-border'}`}
          >
            All
          </button>
          {groupList.map(g => (
            <button
              key={g.id}
              onClick={() => setActiveGroup(activeGroup === g.id ? null : g.id)}
              className={`badge px-2 py-1 text-xs transition-colors`}
              style={activeGroup === g.id
                ? { background: (g.color || '#3b82f6') + '33', color: g.color || '#3b82f6', border: `1px solid ${g.color || '#3b82f6'}66` }
                : { background: '#1a1d27', color: '#6b7280', border: '1px solid #2e3347' }
              }
            >
              {g.name} <span className="ml-1 opacity-60">{g.server_count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          className="input flex-1 max-w-xs text-xs py-1"
          placeholder="Search servers…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="input w-auto text-xs py-1" value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}>
          <option value="status">Sort: Status</option>
          <option value="updates">Sort: Updates</option>
          <option value="name">Sort: Name</option>
        </select>
        <button onClick={handleCheckAll} disabled={checkingAll} className="btn-secondary text-xs">
          {checkingAll ? 'Checking…' : 'Check All'}
        </button>
        {serversWithUpdates.length > 0 && (
          <button onClick={() => setShowUpgradeAll(true)} className="btn-amber text-xs">
            Upgrade All ({serversWithUpdates.length})
          </button>
        )}
      </div>

      {/* Server cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {filtered.map(s => (
          <ServerCard
            key={s.id}
            server={s}
            checking={checking.has(s.id)}
            onCheck={() => handleCheck(s.id)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="col-span-full py-12 text-center text-text-muted text-sm">
            {serverList.length === 0 ? (
              <>No servers yet. <Link to="/settings" className="text-cyan underline">Add one in Settings.</Link></>
            ) : 'No servers match your filter.'}
          </div>
        )}
      </div>

      {showUpgradeAll && (
        <UpgradeAllModal
          servers={serversWithUpdates}
          onClose={() => { setShowUpgradeAll(false); load() }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Server card
// ---------------------------------------------------------------------------
function ServerCard({ server: s, checking, onCheck }: {
  server: Server
  checking: boolean
  onCheck: () => void
}) {
  const status = checking ? 'checking' : serverStatus(s)
  const c = s.latest_check

  return (
    <div className={`card p-3 space-y-2 transition-colors ${!s.is_enabled ? 'opacity-50' : ''}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <StatusDot status={status} />
            <Link to={`/servers/${s.id}`} className="font-mono text-sm text-text-primary hover:text-green truncate">
              {s.name}
            </Link>
          </div>
          <div className="font-mono text-xs text-text-muted truncate">{s.hostname}</div>
        </div>
        {s.group_name && (
          <span
            className="badge text-xs shrink-0"
            style={{ background: (s.group_color || '#3b82f6') + '22', color: s.group_color || '#3b82f6', border: `1px solid ${s.group_color || '#3b82f6'}44` }}
          >
            {s.group_name}
          </span>
        )}
      </div>

      {/* OS */}
      {s.os_info && <div className="text-xs text-text-muted font-mono truncate">{s.os_info}</div>}

      {/* Update counts */}
      {c && c.packages_available > 0 && (
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-mono font-medium text-amber">{c.packages_available}</span>
          <span className="text-xs text-text-muted">
            updates
            {c.security_packages > 0 && (
              <span className="ml-1 text-red font-medium">· {c.security_packages} security</span>
            )}
          </span>
        </div>
      )}

      {c && c.packages_available === 0 && c.status === 'success' && (
        <div className="text-xs text-green font-mono">✓ up to date</div>
      )}

      {c?.status === 'error' && (
        <div className="text-xs text-red font-mono truncate" title={c.error_message || ''}>
          ✗ {c.error_message || 'error'}
        </div>
      )}

      {/* Badges */}
      <div className="flex flex-wrap gap-1">
        {c?.reboot_required && (
          <span className="badge bg-amber/10 text-amber border border-amber/30 text-xs">↻ reboot</span>
        )}
        {c && c.held_packages > 0 && (
          <span className="badge bg-blue/10 text-blue border border-blue/30 text-xs">{c.held_packages} held</span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-border/50">
        <span className="text-xs text-text-muted font-mono">{relativeTime(c?.checked_at || null)}</span>
        <div className="flex gap-1">
          <button onClick={onCheck} disabled={checking} className="btn-secondary text-xs py-0.5">
            {checking ? '…' : 'Check'}
          </button>
          {c && c.packages_available > 0 && (
            <Link to={`/servers/${s.id}`} className="btn-amber text-xs py-0.5">
              Upgrade
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
