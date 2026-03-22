import { useState, useCallback, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { servers as serversApi, groups as groupsApi, stats as statsApi } from '@/api/client'
import type { Server, ServerGroup, FleetOverview, ServerStatus } from '@/types'
import { usePolling } from '@/hooks/usePolling'
import { useAuthStore } from '@/hooks/useAuth'
import StatusDot from '@/components/StatusDot'
import UpgradeAllModal from '@/components/UpgradeAllModal'
import { PieChart, Pie, Cell, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts'

function osIcon(osInfo: string | null): string {
  if (!osInfo) return '🖥'
  const s = osInfo.toLowerCase()
  if (s.includes('ubuntu')) return '🟠'
  if (s.includes('raspbian') || s.includes('raspberry')) return '🍓'
  if (s.includes('debian')) return '🌀'
  if (s.includes('fedora')) return '🎩'
  if (s.includes('arch')) return '🔵'
  if (s.includes('alpine')) return '🏔'
  return '🐧'
}

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
  const [sortBy, setSortBy] = useState<'name' | 'updates' | 'status' | 'group'>('status')
  const [groupView, setGroupView] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [checking, setChecking] = useState<Set<number>>(new Set())
  const [showUpgradeAll, setShowUpgradeAll] = useState(false)
  const [upgradeMinimized, setUpgradeMinimized] = useState(false)
  const [checkingAll, setCheckingAll] = useState(false)
  const [showUpdatesSummary, setShowUpdatesSummary] = useState(false)
  const [reachability, setReachability] = useState<Record<number, boolean | null>>({})

  const isDefaultPassword = user?.is_default_password === true

  async function pingAll(srvList: Server[]) {
    const results: Record<number, boolean | null> = {}
    await Promise.allSettled(srvList.map(async s => {
      try {
        const r = await serversApi.test(s.id)
        results[s.id] = r.success
      } catch {
        results[s.id] = false
      }
    }))
    setReachability(results)
  }

  const load = useCallback(async () => {
    const [s, g, o] = await Promise.all([
      serversApi.list(),
      groupsApi.list(),
      statsApi.overview(),
    ])
    setServerList(s)
    setGroupList(g)
    setOverview(o)
    return s
  }, [])

  usePolling(load, 30_000)

  // Immediately re-fetch when an operation completes on any server
  useEffect(() => {
    const handler = () => load()
    window.addEventListener('apt:refresh', handler)
    return () => window.removeEventListener('apt:refresh', handler)
  }, [load])

  // Ping all servers once on mount, then every 5 minutes (SSH test is heavier than polling)
  useEffect(() => {
    load().then(s => s && pingAll(s))
    const id = setInterval(() => {
      if (serverList.length > 0) pingAll(serverList)
    }, 5 * 60_000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const allTags = Array.from(new Set(serverList.flatMap(s => s.tags ?? []))).sort()

  const filtered = serverList
    .filter(s => activeGroup == null || s.group_id === activeGroup)
    .filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.hostname.includes(search))
    .filter(s => !tagFilter || (s.tags ?? []).includes(tagFilter))
    .filter(s => {
      if (!statusFilter) return true
      const c = s.latest_check
      if (statusFilter === 'up_to_date') return c?.status === 'success' && c.packages_available === 0
      if (statusFilter === 'updates_available') return (c?.packages_available ?? 0) > 0
      if (statusFilter === 'security') return (c?.security_packages ?? 0) > 0
      if (statusFilter === 'error') return c?.status === 'error'
      if (statusFilter === 'reboot') return c?.reboot_required === true
      if (statusFilter === 'held') return (c?.held_packages ?? 0) > 0
      if (statusFilter === 'autoremove') return (c?.autoremove_count ?? 0) > 0
      return true
    })
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      if (sortBy === 'updates') return (b.latest_check?.packages_available ?? 0) - (a.latest_check?.packages_available ?? 0)
      if (sortBy === 'group') {
        const ga = a.group_name ?? 'zzz'
        const gb = b.group_name ?? 'zzz'
        if (ga !== gb) return ga.localeCompare(gb)
        return a.name.localeCompare(b.name)
      }
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
        <>
          <div className="flex flex-wrap gap-2 items-stretch">
            {/* Tiny donut showing overall fleet health */}
            <div className="card px-3 py-2 flex items-center justify-center" style={{ minWidth: 72 }}>
              <PieChart width={52} height={52}>
                <Pie
                  data={[
                    { value: overview.up_to_date, color: '#22c55e' },
                    { value: overview.updates_available, color: '#f59e0b' },
                    { value: overview.errors, color: '#ef4444' },
                  ].filter(d => d.value > 0)}
                  cx="50%" cy="50%" innerRadius={16} outerRadius={24} dataKey="value" strokeWidth={0}
                >
                  {[
                    { value: overview.up_to_date, color: '#22c55e' },
                    { value: overview.updates_available, color: '#f59e0b' },
                    { value: overview.errors, color: '#ef4444' },
                  ].filter(d => d.value > 0).map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <ReTooltip formatter={(v: number) => [v]} contentStyle={{ background: '#1a1d27', border: '1px solid #2d3142', fontSize: 11 }} />
              </PieChart>
            </div>
            {[
              { label: 'Total', value: overview.total_servers, color: 'text-text-primary', filter: null },
              { label: 'Up to date', value: overview.up_to_date, color: 'text-green', filter: 'up_to_date' },
              { label: 'Updates', value: overview.updates_available, color: overview.updates_available > 0 ? 'text-amber' : 'text-text-muted', filter: 'updates_available' },
              { label: 'Security', value: overview.security_updates_total, color: overview.security_updates_total > 0 ? 'text-red' : 'text-text-muted', filter: 'security' },
              { label: 'Errors', value: overview.errors, color: overview.errors > 0 ? 'text-red' : 'text-text-muted', filter: 'error' },
              { label: 'Reboot', value: overview.reboot_required, color: overview.reboot_required > 0 ? 'text-amber' : 'text-text-muted', filter: 'reboot' },
              { label: 'Held pkgs', value: overview.held_packages_total, color: overview.held_packages_total > 0 ? 'text-blue' : 'text-text-muted', filter: 'held' },
              { label: 'Autoremove', value: overview.autoremove_total, color: overview.autoremove_total > 0 ? 'text-amber' : 'text-text-muted', filter: 'autoremove' },
            ].map(({ label, value, color, filter }) => (
              <button
                key={label}
                onClick={() => setStatusFilter(statusFilter === filter ? null : filter)}
                className={`card px-3 py-2 text-center cursor-pointer hover:border-text-muted transition-colors ${statusFilter === filter ? 'border-green/50 bg-green/5' : ''}`}
                style={{ minWidth: 72 }}
              >
                <div className={`text-xl font-mono font-medium ${color}`}>{value}</div>
                <div className="text-xs text-text-muted">{label}</div>
              </button>
            ))}
          </div>
          {statusFilter && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setStatusFilter(null)}
                className="badge px-2 py-0.5 text-xs bg-surface-2 text-text-muted border border-border hover:border-text-muted transition-colors"
              >
                × Clear filter
              </button>
              <span className="text-xs text-text-muted">Showing: {statusFilter.replace('_', ' ')}</span>
            </div>
          )}
        </>
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

      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-xs text-text-muted">Tags:</span>
          {allTags.map(tag => (
            <button
              key={tag}
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              className={`badge px-2 py-0.5 text-xs transition-colors ${tagFilter === tag ? 'bg-cyan/20 text-cyan border-cyan/40' : 'bg-surface-2 text-text-muted border-border'}`}
            >
              {tag}
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
          <option value="group">Sort: Group</option>
        </select>
        <button
          onClick={() => setGroupView(v => !v)}
          className={`btn-secondary text-xs ${groupView ? 'bg-surface-2' : ''}`}
          title="Group by server group"
        >
          ⊞ Group
        </button>
        <button onClick={handleCheckAll} disabled={checkingAll} className="btn-secondary text-xs">
          {checkingAll ? `Checking… (${serverList.filter(s => s.latest_check).length}/${serverList.length})` : 'Check All'}
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

      {/* Check-all progress banner */}
      {checkingAll && (
        <div className="bg-cyan/10 border border-cyan/30 rounded px-3 py-2 text-sm text-cyan font-mono flex items-center gap-2">
          <span className="animate-pulse">⚙</span>
          Checking all servers for updates… this may take a minute.
        </div>
      )}

      {/* Updates summary table */}
      {showUpdatesSummary && serversWithUpdates.length > 0 && (
        <UpdatesSummary servers={serversWithUpdates} />
      )}

      {/* Server cards */}
      {groupView ? (
        <div className="space-y-6">
          {filtered.length === 0 && (
            <div className="py-12 text-center text-text-muted text-sm">
              {serverList.length === 0 ? (
                <>No servers yet. <Link to="/settings" className="text-cyan underline">Add one in Settings.</Link></>
              ) : 'No servers match your filter.'}
            </div>
          )}
          {Array.from(new Map(
            filtered.map(s => [s.group_name ?? null, s.group_color ?? null])
          ).entries()).map(([groupName, groupColor]) => {
            const groupServers = filtered.filter(s => (s.group_name ?? null) === groupName)
            return (
              <div key={groupName ?? 'ungrouped'}>
                <div className="flex items-center gap-2 mb-2">
                  {groupColor && <span className="w-3 h-3 rounded-full inline-block" style={{ background: groupColor }} />}
                  <span className="text-sm font-mono text-text-muted">{groupName ?? 'Ungrouped'}</span>
                  <span className="text-xs text-text-muted">({groupServers.length})</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {groupServers.map(s => (
                    <ServerCard key={s.id} server={s} checking={checking.has(s.id)} onCheck={() => handleCheck(s.id)} reachable={reachability[s.id]} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map(s => (
            <ServerCard
              key={s.id}
              server={s}
              checking={checking.has(s.id)}
              onCheck={() => handleCheck(s.id)}
              reachable={reachability[s.id]}
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
      )}

      {showUpgradeAll && upgradeMinimized && (
        <div
          className="fixed bottom-4 right-4 z-50 bg-surface border border-cyan/50 rounded-lg px-4 py-3 cursor-pointer shadow-lg flex items-center gap-3"
          onClick={() => setUpgradeMinimized(false)}
        >
          <span className="text-cyan animate-pulse">⚙</span>
          <span className="font-mono text-sm text-text-primary">Upgrade running…</span>
          <span className="text-text-muted text-xs">click to expand</span>
        </div>
      )}
      {showUpgradeAll && !upgradeMinimized && (
        <UpgradeAllModal
          servers={serversWithUpdates}
          onClose={() => { setShowUpgradeAll(false); setUpgradeMinimized(false); load() }}
          onMinimize={() => setUpgradeMinimized(true)}
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
function ServerCard({ server: s, checking, onCheck, reachable }: {
  server: Server
  checking: boolean
  onCheck: () => void
  reachable?: boolean | null
}) {
  const navigate = useNavigate()
  const status = checking ? 'checking' : serverStatus(s)
  const c = s.latest_check

  const groupColor = s.group_color || null

  return (
    <div
      className={`card p-3 space-y-2 transition-colors cursor-pointer ${!s.is_enabled ? 'opacity-50' : ''}`}
      style={groupColor ? { borderLeft: `3px solid ${groupColor}66` } : undefined}
      onClick={() => navigate(`/servers/${s.id}`)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <StatusDot status={status} />
            <span className="font-mono text-sm text-text-primary truncate">
              {s.name}
            </span>
          </div>
          <div className="flex items-center font-mono text-xs text-text-muted truncate">
            {reachable === false && <span title="Unreachable" className="w-2 h-2 rounded-full bg-red inline-block mr-1" />}
            {reachable === true && <span title="Reachable" className="w-2 h-2 rounded-full bg-green inline-block mr-1" />}
            {(reachable === null || reachable === undefined) && <span className="w-2 h-2 rounded-full bg-gray-600 inline-block mr-1" />}
            {s.hostname}
          </div>
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
      {s.os_info && (
        <div className="text-xs text-text-muted font-mono truncate">
          <span className="mr-1">{osIcon(s.os_info)}</span>{s.os_info}
        </div>
      )}

      {/* Tags */}
      {s.tags && s.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {s.tags.map(t => (
            <span key={t} className="badge text-xs bg-surface-2 text-text-muted border border-border">{t}</span>
          ))}
        </div>
      )}

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
          <button
            className="badge bg-amber/10 text-amber border border-amber/30 text-xs cursor-pointer hover:bg-amber/20"
            onClick={e => { e.stopPropagation(); navigate(`/servers/${s.id}`, { state: { tab: 'Packages' } }) }}
          >
            {c.autoremove_count} to remove
          </button>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-border/50">
        <span className="text-xs text-text-muted font-mono">{relativeTime(c?.checked_at || null)}</span>
        <div className="flex gap-1 flex-wrap justify-end">
          <button onClick={e => { e.stopPropagation(); onCheck() }} disabled={checking} className="btn-secondary text-xs py-0.5">
            {checking ? '…' : 'Check'}
          </button>
          {c && c.packages_available > 0 && (
            <Link to={`/servers/${s.id}`} onClick={e => e.stopPropagation()} className="btn-amber text-xs py-0.5">
              Upgrade
            </Link>
          )}
          {c?.reboot_required && (
            <span onClick={e => e.stopPropagation()}>
              <RebootButton serverId={s.id} serverName={s.name} />
            </span>
          )}
          <Link to={`/servers/${s.id}`} state={{ openEdit: true }} onClick={e => e.stopPropagation()} className="btn-secondary text-xs py-0.5">
            ✎
          </Link>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fleet charts
// ---------------------------------------------------------------------------
function FleetCharts({ overview }: { overview: FleetOverview }) {
  const data = [
    { name: 'Up to date', value: overview.up_to_date, color: '#22c55e' },
    { name: 'Updates available', value: overview.updates_available, color: '#f59e0b' },
    { name: 'Errors', value: overview.errors, color: '#ef4444' },
  ].filter(d => d.value > 0)

  if (data.length === 0) return null

  return (
    <div className="card p-4">
      <div className="text-xs text-text-muted mb-2 font-mono">Fleet Status</div>
      <div className="flex items-center gap-6">
        <ResponsiveContainer width={120} height={120}>
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={35} outerRadius={55} dataKey="value" strokeWidth={0}>
              {data.map((entry, i) => <Cell key={i} fill={entry.color} />)}
            </Pie>
            <ReTooltip formatter={(v: number, n: string) => [v, n]} contentStyle={{ background: '#1a1d27', border: '1px solid #2d3142', fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-1">
          {data.map(d => (
            <div key={d.name} className="flex items-center gap-2 text-xs text-text-muted">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: d.color }} />
              {d.name}: <span className="text-text-primary font-mono">{d.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
