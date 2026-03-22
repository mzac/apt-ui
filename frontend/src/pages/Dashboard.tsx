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
  const [showUpdatesSummary, setShowUpdatesSummary] = useState(false)

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
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {[
            { label: 'Total', value: overview.total_servers, color: 'text-text-primary' },
            { label: 'Up to date', value: overview.up_to_date, color: 'text-green' },
            { label: 'Updates', value: overview.updates_available, color: overview.updates_available > 0 ? 'text-amber' : 'text-text-muted' },
            { label: 'Security', value: overview.security_updates_total, color: overview.security_updates_total > 0 ? 'text-red' : 'text-text-muted' },
            { label: 'Errors', value: overview.errors, color: overview.errors > 0 ? 'text-red' : 'text-text-muted' },
            { label: 'Reboot', value: overview.reboot_required, color: overview.reboot_required > 0 ? 'text-amber' : 'text-text-muted' },
            { label: 'Held pkgs', value: overview.held_packages_total, color: overview.held_packages_total > 0 ? 'text-blue' : 'text-text-muted' },
            { label: 'Autoremove', value: overview.autoremove_total, color: overview.autoremove_total > 0 ? 'text-amber' : 'text-text-muted' },
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

      {/* Group filter — only groups that have servers */}
      {groupList.some(g => g.server_count > 0) && (
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setActiveGroup(null)}
            className={`badge px-2 py-1 text-xs transition-colors ${activeGroup == null ? 'bg-green/20 text-green border border-green/40' : 'bg-surface-2 text-text-muted border border-border'}`}
          >
            All
          </button>
          {groupList.filter(g => g.server_count > 0).map(g => {
            const c = g.color || '#3b82f6'
            const active = activeGroup === g.id
            return (
              <button
                key={g.id}
                onClick={() => setActiveGroup(active ? null : g.id)}
                className="badge px-2 py-1 text-xs transition-all"
                style={active
                  ? { background: c + '33', color: c, border: `1px solid ${c}88`, boxShadow: `0 0 0 1px ${c}44` }
                  : { background: c + '18', color: c, border: `1px solid ${c}44`, opacity: 0.85 }
                }
              >
                {g.name} <span className="ml-1 opacity-60">{g.server_count}</span>
              </button>
            )
          })}
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
        {serversWithUpdates.length > 0 && (
          <button onClick={() => setShowUpdatesSummary(v => !v)} className="btn-secondary text-xs">
            {showUpdatesSummary ? 'Hide Summary' : `All Updates`}
          </button>
        )}
      </div>

      {/* Updates summary table */}
      {showUpdatesSummary && serversWithUpdates.length > 0 && (
        <UpdatesSummary servers={serversWithUpdates} />
      )}

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
// Updates summary table
// ---------------------------------------------------------------------------
function UpdatesSummary({ servers }: { servers: Server[] }) {
  // Sort: most updates first, security at top
  const sorted = [...servers].sort((a, b) => {
    const secDiff = (b.latest_check?.security_packages ?? 0) - (a.latest_check?.security_packages ?? 0)
    if (secDiff !== 0) return secDiff
    return (b.latest_check?.packages_available ?? 0) - (a.latest_check?.packages_available ?? 0)
  })

  const totalPkgs = servers.reduce((sum, s) => sum + (s.latest_check?.packages_available ?? 0), 0)
  const totalSec = servers.reduce((sum, s) => sum + (s.latest_check?.security_packages ?? 0), 0)

  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-mono text-text-muted">
          {servers.length} servers · {totalPkgs} packages
          {totalSec > 0 && <span className="text-red ml-2">· {totalSec} security</span>}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-xs">
              <th className="px-3 py-2 text-left font-normal">Server</th>
              <th className="px-3 py-2 text-left font-normal">Hostname</th>
              <th className="px-3 py-2 text-right font-normal">Updates</th>
              <th className="px-3 py-2 text-right font-normal">Security</th>
              <th className="px-3 py-2 text-right font-normal">Held</th>
              <th className="px-3 py-2 text-left font-normal">Flags</th>
              <th className="px-3 py-2 text-right font-normal">Checked</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(s => {
              const c = s.latest_check!
              return (
                <tr key={s.id} className="border-b border-border/50 hover:bg-surface-2/50 transition-colors">
                  <td className="px-3 py-2">
                    <Link to={`/servers/${s.id}`} className="font-mono text-text-primary hover:text-green">
                      {s.name}
                    </Link>
                    {s.group_name && (
                      <span className="ml-2 badge text-xs" style={{ background: (s.group_color || '#3b82f6') + '22', color: s.group_color || '#3b82f6', border: `1px solid ${s.group_color || '#3b82f6'}44` }}>
                        {s.group_name}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-text-muted">{s.hostname}</td>
                  <td className="px-3 py-2 text-right font-mono text-amber font-medium">{c.packages_available}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.security_packages > 0
                      ? <span className="text-red font-medium">{c.security_packages}</span>
                      : <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-text-muted">
                    {c.held_packages > 0 ? c.held_packages : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 flex-wrap">
                      {c.reboot_required && <span className="badge bg-amber/10 text-amber border border-amber/30 text-xs">↻ reboot</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-text-muted">
                    {relativeTime(c.checked_at || null)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reboot confirmation button (shared)
// ---------------------------------------------------------------------------
function RebootButton({ serverId, serverName, className = '' }: {
  serverId: number
  serverName: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'confirm' | 'rebooting'>('idle')
  const [result, setResult] = useState<string | null>(null)

  async function doReboot() {
    setState('rebooting')
    setResult(null)
    try {
      const res = await serversApi.reboot(serverId)
      setResult(res.success ? 'Reboot command sent.' : res.detail)
    } catch (err: unknown) {
      setResult((err as Error).message)
    } finally {
      setState('idle')
    }
  }

  if (state === 'confirm') {
    return (
      <span className="flex items-center gap-1">
        <span className="text-xs text-amber font-mono">Reboot {serverName}?</span>
        <button onClick={doReboot} className="btn-danger text-xs py-0.5">Yes, reboot</button>
        <button onClick={() => setState('idle')} className="btn-secondary text-xs py-0.5">Cancel</button>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1">
      <button
        onClick={() => setState('confirm')}
        disabled={state === 'rebooting'}
        className={`btn-secondary text-xs py-0.5 text-amber border-amber/40 hover:border-amber/70 ${className}`}
      >
        {state === 'rebooting' ? 'Rebooting…' : '↻ Reboot'}
      </button>
      {result && <span className="text-xs font-mono text-text-muted">{result}</span>}
    </span>
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

  const groupColor = s.group_color || null

  return (
    <div
      className={`card p-3 space-y-2 transition-colors ${!s.is_enabled ? 'opacity-50' : ''}`}
      style={groupColor ? { borderLeft: `3px solid ${groupColor}66` } : undefined}
    >
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
          <span className="badge bg-amber/10 text-amber border border-amber/30 text-xs">↻ reboot required</span>
        )}
        {c && c.held_packages > 0 && (
          <span className="badge bg-blue/10 text-blue border border-blue/30 text-xs">{c.held_packages} held</span>
        )}
        {c && c.autoremove_count > 0 && (
          <span className="badge bg-amber/10 text-amber border border-amber/30 text-xs">{c.autoremove_count} to remove</span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-border/50">
        <span className="text-xs text-text-muted font-mono">{relativeTime(c?.checked_at || null)}</span>
        <div className="flex gap-1 flex-wrap justify-end">
          <button onClick={onCheck} disabled={checking} className="btn-secondary text-xs py-0.5">
            {checking ? '…' : 'Check'}
          </button>
          {c && c.packages_available > 0 && (
            <Link to={`/servers/${s.id}`} className="btn-amber text-xs py-0.5">
              Upgrade
            </Link>
          )}
          {c?.reboot_required && (
            <RebootButton serverId={s.id} serverName={s.name} />
          )}
          <Link to={`/servers/${s.id}`} state={{ openEdit: true }} className="btn-secondary text-xs py-0.5">
            ✎
          </Link>
        </div>
      </div>
    </div>
  )
}
