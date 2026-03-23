import { useState, useCallback, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { servers as serversApi, groups as groupsApi, stats as statsApi } from '@/api/client'
import type { Server, ServerGroup, FleetOverview, ServerStatus, Tag } from '@/types'
import { usePolling } from '@/hooks/usePolling'
import { useAuthStore } from '@/hooks/useAuth'
import { useJobStore } from '@/hooks/useJobStore'
import StatusDot from '@/components/StatusDot'
import UpgradeAllModal from '@/components/UpgradeAllModal'
import PackageInstallModal from '@/components/PackageInstallModal'
import { PieChart, Pie, Cell, Tooltip as ReTooltip } from 'recharts'

function osIcon(osInfo: string | null): string {
  if (!osInfo) return '🖥'
  const s = osInfo.toLowerCase()
  if (s.includes('ubuntu')) return '🟠'
  if (s.includes('raspbian') || s.includes('raspberry')) return '🍓'
  if (s.includes('debian')) return '🌀'
  if (s.includes('fedora')) return '🎩'
  if (s.includes('arch')) return '🔵'
  if (s.includes('alpine')) return '🏔'
  if (s.includes('proxmox')) return '🔶'
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

// Custom pie tooltip
const PieTooltipContent = ({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ name: string; value: number; payload: { label: string; color: string } }>
}) => {
  if (!active || !payload?.length) return null
  const { label, color } = payload[0].payload
  const value = payload[0].value
  return (
    <div style={{
      background: '#1a1d27',
      border: `1px solid ${color}`,
      borderRadius: 4,
      padding: '4px 8px',
      fontSize: 11,
      color: '#e2e8f0',
      whiteSpace: 'nowrap',
    }}>
      <span style={{ color }}>{label}: </span>{value}
    </div>
  )
}

export default function Dashboard() {
  const { user } = useAuthStore()
  const [serverList, setServerList] = useState<Server[]>([])
  const [groupList, setGroupList] = useState<ServerGroup[]>([])
  const [overview, setOverview] = useState<FleetOverview | null>(null)
  const [activeGroup, setActiveGroup] = useState<number | null>(null)
  const [activeTag, setActiveTag] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'name' | 'updates' | 'status' | 'group'>(
    () => (sessionStorage.getItem('dashboard:sortBy') as 'name' | 'updates' | 'status' | 'group') || 'status'
  )
  const [groupView, setGroupView] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [checking, setChecking] = useState<Set<number>>(new Set())
  const { addJob, updateJob } = useJobStore()
  const [showUpgradeAll, setShowUpgradeAll] = useState(false)
  const [upgradeMinimized, setUpgradeMinimized] = useState(false)
  const [checkingAll, setCheckingAll] = useState(false)
  const [checkProgress, setCheckProgress] = useState<{ done: number; total: number; current: string[] }>({ done: 0, total: 0, current: [] })
  const [showUpdatesSummary, setShowUpdatesSummary] = useState(false)
  const [reachability, setReachability] = useState<Record<number, boolean | null>>({})
  const [confirmDisable, setConfirmDisable] = useState<Server | null>(null)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  // Collect all unique tags from server list
  const allTags: Tag[] = []
  const seenTagIds = new Set<number>()
  for (const s of serverList) {
    for (const t of (s.tags ?? [])) {
      if (!seenTagIds.has(t.id)) {
        seenTagIds.add(t.id)
        allTags.push(t)
      }
    }
  }
  allTags.sort((a, b) => a.name.localeCompare(b.name))

  const filtered = serverList
    .filter(s => activeGroup == null || (s.groups ?? []).some(g => g.id === activeGroup))
    .filter(s => activeTag == null || (s.tags ?? []).some(t => t.id === activeTag))
    .filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.hostname.includes(search))
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

  async function handleToggleEnabled(s: Server, e: React.MouseEvent) {
    e.stopPropagation()
    if (s.is_enabled) {
      setConfirmDisable(s)
      return
    }
    try {
      await serversApi.update(s.id, { is_enabled: true })
      await load()
    } catch {}
  }

  async function confirmDoDisable() {
    if (!confirmDisable) return
    try {
      await serversApi.update(confirmDisable.id, { is_enabled: false })
      await load()
    } catch {}
    setConfirmDisable(null)
  }

  async function handleCheckAll() {
    setCheckingAll(true)
    setCheckProgress({ done: 0, total: 0, current: [] })
    addJob({ id: 'check-all', type: 'check-all', label: 'Check All', status: 'running', link: '/', startedAt: Date.now() })
    try {
      const res = await serversApi.checkAll()
      const total = res.total || serverList.filter(s => s.is_enabled).length

      // Poll progress
      progressIntervalRef.current = setInterval(async () => {
        try {
          const prog = await serversApi.checkProgress()
          setCheckProgress({ done: prog.done, total: prog.total || total, current: prog.current_servers })
          if (!prog.running) {
            clearInterval(progressIntervalRef.current!)
            progressIntervalRef.current = null
            setCheckingAll(false)
            updateJob('check-all', { status: 'complete', completedAt: Date.now() })
            await load()
          }
        } catch {
          clearInterval(progressIntervalRef.current!)
          progressIntervalRef.current = null
          setCheckingAll(false)
          updateJob('check-all', { status: 'error', completedAt: Date.now() })
        }
      }, 2000)
    } catch {
      setCheckingAll(false)
      updateJob('check-all', { status: 'error', completedAt: Date.now() })
    }
  }

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current)
    }
  }, [])

  // Listen for restore event from bell dropdown
  useEffect(() => {
    function onRestore() {
      setShowUpgradeAll(true)
      setUpgradeMinimized(false)
    }
    window.addEventListener('apt:restore-upgrade-all', onRestore)
    return () => window.removeEventListener('apt:restore-upgrade-all', onRestore)
  }, [])

  const serversWithUpdates = filtered.filter(s => (s.latest_check?.packages_available ?? 0) > 0)
  const hasFilters = activeGroup != null || activeTag != null

  // Groups with servers (including via memberships)
  const groupsWithServers = groupList.filter(g => g.server_count > 0 ||
    serverList.some(s => (s.groups ?? []).some(sg => sg.id === g.id)))

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
          <div className="flex flex-wrap gap-2 items-stretch overflow-x-auto pb-1">
            {/* Tiny donut showing overall fleet health */}
            <div className="card px-3 py-2 flex items-center justify-center" style={{ minWidth: 72 }}>
              <PieChart width={52} height={52}>
                <Pie
                  data={[
                    { value: overview.up_to_date, color: '#22c55e', label: 'Up to date' },
                    { value: overview.updates_available, color: '#f59e0b', label: 'Updates' },
                    { value: overview.errors, color: '#ef4444', label: 'Errors' },
                  ].filter(d => d.value > 0)}
                  cx="50%" cy="50%" innerRadius={16} outerRadius={24} dataKey="value" strokeWidth={0}
                >
                  {[
                    { value: overview.up_to_date, color: '#22c55e', label: 'Up to date' },
                    { value: overview.updates_available, color: '#f59e0b', label: 'Updates' },
                    { value: overview.errors, color: '#ef4444', label: 'Errors' },
                  ].filter(d => d.value > 0).map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <ReTooltip content={<PieTooltipContent />} />
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

      {/* Combined groups + tags filter row */}
      {(groupsWithServers.length > 0 || allTags.length > 0) && (
        <div className="flex flex-wrap gap-1 items-center">
          <button
            onClick={() => { setActiveGroup(null); setActiveTag(null) }}
            className={`badge px-2 py-1 text-xs transition-colors ${!hasFilters ? 'bg-green/20 text-green border border-green/40' : 'bg-surface-2 text-text-muted border border-border'}`}
          >
            All
          </button>

          {/* Groups */}
          {groupsWithServers.length > 0 && (
            <>
              {groupsWithServers.map(g => {
                const c = g.color || '#3b82f6'
                const active = activeGroup === g.id
                return (
                  <button
                    key={`g-${g.id}`}
                    onClick={() => { setActiveGroup(active ? null : g.id); setActiveTag(null) }}
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
            </>
          )}

          {/* Thin separator between groups and tags */}
          {groupsWithServers.length > 0 && allTags.length > 0 && (
            <span className="w-px h-4 bg-border mx-1" />
          )}

          {/* Tags */}
          {allTags.map(tag => {
            const active = activeTag === tag.id
            const c = tag.color || '#6366f1'
            const count = serverList.filter(s => s.tags?.some(t => t.id === tag.id)).length
            return (
              <button
                key={`t-${tag.id}`}
                onClick={() => { setActiveTag(active ? null : tag.id); setActiveGroup(null) }}
                className="badge px-2 py-1 text-xs transition-all"
                style={active
                  ? { background: c + '33', color: c, border: `1px solid ${c}88`, boxShadow: `0 0 0 1px ${c}44` }
                  : { background: c + '18', color: c, border: `1px solid ${c}44`, opacity: 0.85 }
                }
              >
                # {tag.name} <span className="ml-1 opacity-60">{count}</span>
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
        <select className="input w-auto text-xs py-1" value={sortBy} onChange={e => { const v = e.target.value as typeof sortBy; setSortBy(v); sessionStorage.setItem('dashboard:sortBy', v) }}>
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
          {checkingAll
            ? `Checking… ${checkProgress.done}/${checkProgress.total}`
            : 'Check All'}
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
          <span>
            Checking… {checkProgress.done}/{checkProgress.total}
            {checkProgress.current.length > 0 && (
              <span className="text-cyan/70 ml-2">· {checkProgress.current.join(', ')}</span>
            )}
          </span>
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
                    <ServerCard
                      key={s.id}
                      server={s}
                      checking={checking.has(s.id)}
                      onCheck={() => handleCheck(s.id)}
                      onToggleEnabled={(e) => handleToggleEnabled(s, e)}
                      reachable={reachability[s.id]}
                    />
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
              onToggleEnabled={(e) => handleToggleEnabled(s, e)}
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

      {showUpgradeAll && (
        <div style={{ display: upgradeMinimized ? 'none' : undefined }}>
          <UpgradeAllModal
            servers={serversWithUpdates}
            onClose={() => { setShowUpgradeAll(false); setUpgradeMinimized(false); load() }}
            onMinimize={() => setUpgradeMinimized(true)}
          />
        </div>
      )}

      {/* Custom disable confirmation modal */}
      {confirmDisable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setConfirmDisable(null)}>
          <div className="bg-surface border border-border rounded-lg p-5 max-w-sm w-full space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-mono text-text-primary">Disable server?</h3>
            <p className="text-sm text-text-muted">
              <span className="text-text-primary font-mono">{confirmDisable.name}</span> will be excluded from checks and upgrades until re-enabled.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDisable(null)} className="btn-secondary">Cancel</button>
              <button onClick={confirmDoDisable} className="btn-danger">Disable</button>
            </div>
          </div>
        </div>
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
                    {/* Show primary group */}
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
function ServerCard({ server: s, checking, onCheck, onToggleEnabled, reachable }: {
  server: Server
  checking: boolean
  onCheck: () => void
  onToggleEnabled: (e: React.MouseEvent) => void
  reachable?: boolean | null
}) {
  const navigate = useNavigate()
  const status = checking ? 'checking' : serverStatus(s)
  const c = s.latest_check
  const [showInstall, setShowInstall] = useState(false)

  // Use the first group color for left border accent
  const primaryGroupColor = (s.groups ?? [])[0]?.color || s.group_color || null

  const memGb = s.mem_total_mb ? (s.mem_total_mb / 1024).toFixed(1) : null

  return (
    <div
      className={`card p-3 space-y-2 transition-colors cursor-pointer ${!s.is_enabled ? 'opacity-50' : ''}`}
      style={primaryGroupColor ? { borderLeft: `3px solid ${primaryGroupColor}66` } : undefined}
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
        {/* Group badges (multiple) */}
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          {(s.groups ?? []).slice(0, 2).map(g => (
            <span
              key={g.id}
              className="badge text-xs"
              style={{ background: (g.color || '#3b82f6') + '22', color: g.color || '#3b82f6', border: `1px solid ${g.color || '#3b82f6'}44` }}
            >
              {g.name}
            </span>
          ))}
          {(s.groups ?? []).length > 2 && (
            <span className="badge text-xs bg-surface-2 text-text-muted border border-border">
              +{(s.groups ?? []).length - 2}
            </span>
          )}
          {/* Fallback: if no groups array yet */}
          {(s.groups ?? []).length === 0 && s.group_name && (
            <span
              className="badge text-xs"
              style={{ background: (s.group_color || '#3b82f6') + '22', color: s.group_color || '#3b82f6', border: `1px solid ${s.group_color || '#3b82f6'}44` }}
            >
              {s.group_name}
            </span>
          )}
        </div>
      </div>

      {/* OS */}
      {s.os_info && (
        <div className="text-xs text-text-muted font-mono truncate">
          <span className="mr-1">{osIcon(s.os_info)}</span>{s.os_info}
        </div>
      )}

      {/* Tags with colors */}
      {(s.tags ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(s.tags ?? []).map(t => (
            <span
              key={t.id}
              className="badge text-xs"
              style={{
                background: (t.color || '#6366f1') + '22',
                color: t.color || '#6366f1',
                border: `1px solid ${t.color || '#6366f1'}44`,
              }}
            >
              {t.name}
            </span>
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

      {/* CPU/Memory/disk stats row */}
      {(s.cpu_count != null || memGb != null || s.latest_check) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted font-mono">
          {s.cpu_count != null && <span>{s.cpu_count} CPU</span>}
          {memGb != null && <span>{memGb} GB RAM</span>}
          {s.virt_type && <span>{s.virt_type}</span>}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-border/50">
        <span className="text-xs text-text-muted font-mono">{relativeTime(c?.checked_at || null)}</span>
        <div className="flex gap-1 flex-wrap justify-end items-center">
          {/* Disable/Enable toggle */}
          <button
            onClick={onToggleEnabled}
            className={`text-xs py-0.5 px-1.5 rounded border transition-colors font-mono ${
              s.is_enabled
                ? 'text-text-muted border-border hover:text-red hover:border-red/40'
                : 'text-green border-green/40 hover:border-green/70'
            }`}
            title={s.is_enabled ? 'Disable server' : 'Enable server'}
          >
            {s.is_enabled ? '⏸' : '▶'}
          </button>
          <button onClick={e => { e.stopPropagation(); onCheck() }} disabled={checking} className="btn-secondary text-xs py-0.5">
            {checking ? '…' : 'Check'}
          </button>
          {c && c.packages_available > 0 && (
            <Link to={`/servers/${s.id}`} onClick={e => e.stopPropagation()} className="btn-amber text-xs py-0.5">
              Upgrade
            </Link>
          )}
          <button
            onClick={e => { e.stopPropagation(); setShowInstall(true) }}
            className="btn-secondary text-xs py-0.5"
            title="Install a package"
          >
            + Install
          </button>
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
      {showInstall && (
        <PackageInstallModal
          serverId={s.id}
          serverName={s.name}
          onClose={() => setShowInstall(false)}
        />
      )}
    </div>
  )
}
