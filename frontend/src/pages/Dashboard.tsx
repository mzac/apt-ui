import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { servers as serversApi, groups as groupsApi, stats as statsApi, aptcache as aptcacheApi } from '@/api/client'
import type { Server, ServerGroup, FleetOverview, ServerStatus, Tag, AptCacheStats, AptCacheDailyRow, PackageInfo } from '@/types'
import { usePolling } from '@/hooks/usePolling'
import { useAuthStore } from '@/hooks/useAuth'
import { useJobStore } from '@/hooks/useJobStore'
import { useServersStore } from '@/hooks/useServers'
import StatusDot from '@/components/StatusDot'
import UpgradeAllModal from '@/components/UpgradeAllModal'
import AutoremoveAllModal from '@/components/AutoremoveAllModal'
import RollingRebootModal from '@/components/RollingRebootModal'
import PackageInstallModal from '@/components/PackageInstallModal'
import CopySshButton from '@/components/CopySshButton'
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

function isStale(iso: string | null | undefined, hours = 24): boolean {
  if (!iso) return false
  return Date.now() - new Date(iso).getTime() > hours * 3600_000
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
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [overview, setOverview] = useState<FleetOverview | null>(null)
  // Initialise filters from URL query params so views are bookmarkable/shareable (issue #47)
  const _initialUrl = new URLSearchParams(window.location.search)
  const [activeGroup, setActiveGroup] = useState<number | null>(
    _initialUrl.get('group') ? parseInt(_initialUrl.get('group')!) : null,
  )
  const [activeTag, setActiveTag] = useState<number | null>(
    _initialUrl.get('tag') ? parseInt(_initialUrl.get('tag')!) : null,
  )
  const [search, setSearch] = useState(_initialUrl.get('q') || '')
  const [sortBy, setSortBy] = useState<'name' | 'updates' | 'status' | 'group'>(
    () => (_initialUrl.get('sort') as any) || (localStorage.getItem('dashboard:sortBy') as 'name' | 'updates' | 'status' | 'group') || 'status'
  )
  const [groupView, setGroupView] = useState(_initialUrl.get('view') === 'group')
  const [statusFilter, setStatusFilter] = useState<string | null>(_initialUrl.get('status') || null)
  const [checking, setChecking] = useState<Set<number>>(new Set())
  const { addJob, updateJob } = useJobStore()
  const [showUpgradeAll, setShowUpgradeAll] = useState(false)
  const [upgradeMinimized, setUpgradeMinimized] = useState(false)
  const [showAutoremoveAll, setShowAutoremoveAll] = useState(false)
  const [showRollingReboot, setShowRollingReboot] = useState(false)
  const [checkingAll, setCheckingAll] = useState(false)
  const [checkingMode, setCheckingMode] = useState<'check' | 'refresh' | null>(null)
  const [checkProgress, setCheckProgress] = useState<{ done: number; total: number; current: string[] }>({ done: 0, total: 0, current: [] })
  const [showUpdatesSummary, setShowUpdatesSummary] = useState(false)
  const [showAptCacheDetail, setShowAptCacheDetail] = useState(false)
  const [reachability, setReachability] = useState<Record<number, boolean | null>>({})
  const [confirmDisable, setConfirmDisable] = useState<Server | null>(null)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isDefaultPassword = user?.is_default_password === true

  async function pingAll() {
    try {
      const raw = await serversApi.reachability()
      // API returns Record<string, boolean> — convert keys to numbers
      const results: Record<number, boolean> = {}
      for (const [k, v] of Object.entries(raw)) results[parseInt(k)] = v
      setReachability(results)
    } catch {
      // silently ignore — reachability is best-effort
    }
  }

  const seedPaletteServers = useServersStore(s => s.setServers)

  const load = useCallback(async () => {
    const [s, g, o] = await Promise.all([
      serversApi.list(),
      groupsApi.list(),
      statsApi.overview(),
    ])
    setServerList(s)
    setGroupList(g)
    setOverview(o)
    setInitialLoaded(true)
    // Share the freshly-fetched list with the command palette so it doesn't
    // need to make a duplicate request when first opened.
    seedPaletteServers(s)
    return s
  }, [seedPaletteServers])

  usePolling(load, 30_000)

  // Sync filter state to URL query params so views are bookmarkable (issue #47)
  useEffect(() => {
    const params = new URLSearchParams()
    if (search) params.set('q', search)
    if (statusFilter) params.set('status', statusFilter)
    if (activeGroup != null) params.set('group', String(activeGroup))
    if (activeTag != null) params.set('tag', String(activeTag))
    if (sortBy && sortBy !== 'status') params.set('sort', sortBy)
    if (groupView) params.set('view', 'group')
    const qs = params.toString()
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    if (window.location.search !== (qs ? `?${qs}` : '')) {
      window.history.replaceState(null, '', newUrl)
    }
  }, [search, statusFilter, activeGroup, activeTag, sortBy, groupView])

  // Immediately re-fetch when an operation completes on any server
  useEffect(() => {
    const handler = () => load()
    window.addEventListener('apt:refresh', handler)
    return () => window.removeEventListener('apt:refresh', handler)
  }, [load])

  // Reachability: single endpoint with server-side TTL caching
  useEffect(() => {
    load().then(() => pingAll())
    const id = setInterval(() => pingAll(), 5 * 60_000)
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
    .filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.hostname.toLowerCase().includes(search.toLowerCase()) || (s.tags ?? []).some(t => t.name.toLowerCase().includes(search.toLowerCase())))
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
      if (statusFilter === 'sec_disabled') return s.auto_security_updates === 'disabled' || s.auto_security_updates === 'not_installed'
      if (statusFilter === 'eeprom') return s.eeprom_update_available === 'update_available'
      if (statusFilter === 'offline') return s.is_enabled && s.is_reachable === false
      if (statusFilter === 'eol_soon') return s.os_eol_days_remaining != null && s.os_eol_days_remaining < 365
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
    const s = serverList.find(x => x.id === id)
    const jobId = `check-${id}`
    setChecking(c => new Set(c).add(id))
    addJob({ id: jobId, type: 'check', label: `Check ${s?.name ?? id}`, status: 'running', link: `/servers/${id}`, startedAt: Date.now() })
    try {
      await serversApi.check(id)
      updateJob(jobId, { status: 'complete', completedAt: Date.now() })
      await load()
    } catch {
      updateJob(jobId, { status: 'error', completedAt: Date.now() })
    } finally {
      setChecking(c => { const n = new Set(c); n.delete(id); return n })
    }
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

  async function _runCheckAll(mode: 'check' | 'refresh') {
    setCheckingAll(true)
    setCheckingMode(mode)
    setCheckProgress({ done: 0, total: 0, current: [] })
    const label = mode === 'refresh' ? 'Refresh All' : 'Check All'
    addJob({ id: 'check-all', type: 'check-all', label, status: 'running', link: '/', startedAt: Date.now() })
    try {
      const res = mode === 'refresh' ? await serversApi.refreshAll() : await serversApi.checkAll()
      const total = res.total || serverList.filter(s => s.is_enabled).length

      // Poll progress for the banner — Layout handles the bell job update
      progressIntervalRef.current = setInterval(async () => {
        try {
          const prog = await serversApi.checkProgress()
          setCheckProgress({ done: prog.done, total: prog.total || total, current: prog.current_servers })
          if (!prog.running) {
            clearInterval(progressIntervalRef.current!)
            progressIntervalRef.current = null
            setCheckingAll(false)
            setCheckingMode(null)
            await load()
          }
        } catch {
          clearInterval(progressIntervalRef.current!)
          progressIntervalRef.current = null
          setCheckingAll(false)
          setCheckingMode(null)
        }
      }, 2000)
    } catch {
      setCheckingAll(false)
      setCheckingMode(null)
      updateJob('check-all', { status: 'error', completedAt: Date.now() })
    }
  }

  async function handleCheckAll() { await _runCheckAll('check') }
  async function handleRefreshAll() { await _runCheckAll('refresh') }

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
  const serversWithAutoremove = serverList.filter(s => s.is_enabled && (s.latest_check?.autoremove_count ?? 0) > 0)
  const serversNeedingReboot = serverList.filter(s => s.is_enabled && s.latest_check?.reboot_required === true)
  const hasFilters = activeGroup != null || activeTag != null
  const secDisabledCount = serverList.filter(s => s.auto_security_updates === 'disabled' || s.auto_security_updates === 'not_installed').length
  const eepromCount = serverList.filter(s => s.eeprom_update_available === 'update_available').length
  const offlineCount = serverList.filter(s => s.is_enabled && s.is_reachable === false).length
  const eolSoonCount = serverList.filter(s => s.os_eol_days_remaining != null && s.os_eol_days_remaining < 365).length

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
              { label: 'Security', value: overview.security_servers, color: overview.security_servers > 0 ? 'text-red' : 'text-text-muted', filter: 'security' },
              { label: 'Errors', value: overview.errors, color: overview.errors > 0 ? 'text-red' : 'text-text-muted', filter: 'error' },
              { label: 'Reboot', value: overview.reboot_required, color: overview.reboot_required > 0 ? 'text-amber' : 'text-text-muted', filter: 'reboot' },
              { label: 'Held pkgs', value: overview.held_packages_total, color: overview.held_packages_total > 0 ? 'text-blue' : 'text-text-muted', filter: 'held' },
              { label: 'Autoremove', value: overview.autoremove_total, color: overview.autoremove_total > 0 ? 'text-amber' : 'text-text-muted', filter: 'autoremove' },
              { label: 'Sec off', value: secDisabledCount, color: secDisabledCount > 0 ? 'text-amber' : 'text-text-muted', filter: 'sec_disabled' },
              ...(eepromCount > 0 ? [{ label: 'EEPROM', value: eepromCount, color: 'text-amber', filter: 'eeprom' }] : []),
              ...(offlineCount > 0 ? [{ label: 'Offline', value: offlineCount, color: 'text-red', filter: 'offline' }] : []),
              ...(eolSoonCount > 0 ? [{ label: 'EOL soon', value: eolSoonCount, color: 'text-amber', filter: 'eol_soon' }] : []),
            ].map(({ label, value, color, filter }) => {
              const opensModal = (filter === 'updates_available' || filter === 'security') && serversWithUpdates.length > 0
              const opensAutoremove = filter === 'autoremove' && serversWithAutoremove.length > 0
              const opensRollingReboot = filter === 'reboot' && serversNeedingReboot.length > 0
              return (
                <button
                  key={label}
                  onClick={() => {
                    setStatusFilter(statusFilter === filter ? null : filter)
                    if (opensModal) setShowUpdatesSummary(true)
                    if (opensAutoremove) setShowAutoremoveAll(true)
                    if (opensRollingReboot) setShowRollingReboot(true)
                  }}
                  className={`card px-3 py-2 text-center cursor-pointer hover:border-text-muted transition-colors ${statusFilter === filter ? 'border-green/50 bg-green/5' : ''}`}
                  style={{ minWidth: 72 }}
                  title={
                    opensModal ? 'Click to view pending packages' :
                    opensAutoremove ? 'Click to autoremove on all servers' :
                    opensRollingReboot ? 'Click to start a rolling reboot across the fleet' :
                    undefined
                  }
                >
                  <div className={`text-xl font-mono font-medium ${color}`}>{value}</div>
                  <div className="text-xs text-text-muted">{label}</div>
                </button>
              )
            })}
            <AptCacheCompactCards onOpenDetail={() => setShowAptCacheDetail(true)} />
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
        <select className="input w-auto text-xs py-1" value={sortBy} onChange={e => { const v = e.target.value as typeof sortBy; setSortBy(v); localStorage.setItem('dashboard:sortBy', v) }}>
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
        <div className="relative group/check">
          <button onClick={handleRefreshAll} disabled={checkingAll} className="btn-secondary text-xs">
            {checkingAll && checkingMode === 'refresh'
              ? `Refreshing… ${checkProgress.done}/${checkProgress.total}`
              : 'Refresh All'}
          </button>
          <div className="absolute bottom-full left-0 mb-1.5 w-64 hidden group-hover/check:block pointer-events-none z-20">
            <div className="bg-surface border border-border rounded shadow-lg p-2.5 text-xs text-text-muted leading-snug">
              <p className="font-medium text-text-primary mb-1">Refresh All</p>
              Reads each server's existing local apt cache — no network calls to package repositories.
              Fast but may not reflect the very latest upstream package versions.
            </div>
          </div>
        </div>
        <div className="relative group/checkall">
          <button onClick={handleCheckAll} disabled={checkingAll} className="btn-secondary text-xs">
            {checkingAll && checkingMode === 'check'
              ? `Checking… ${checkProgress.done}/${checkProgress.total}`
              : 'Check All'}
          </button>
          <div className="absolute bottom-full left-0 mb-1.5 w-64 hidden group-hover/checkall:block pointer-events-none z-20">
            <div className="bg-surface border border-border rounded shadow-lg p-2.5 text-xs text-text-muted leading-snug">
              <p className="font-medium text-text-primary mb-1">Check All</p>
              Runs <span className="font-mono">apt-get update</span> on every server to fetch the latest package index from upstream repositories, then reports available upgrades.
              Use this to get an accurate, up-to-date view.
            </div>
          </div>
        </div>
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

      {/* Fleet-wide updates summary modal */}
      {showUpdatesSummary && serversWithUpdates.length > 0 && (
        <UpdatesSummaryModal servers={serversWithUpdates} onClose={() => setShowUpdatesSummary(false)} />
      )}

      {/* apt-cacher-ng detail modal */}
      {showAptCacheDetail && (
        <AptCacheDetailModal onClose={() => setShowAptCacheDetail(false)} />
      )}


      {/* Server cards */}
      {groupView ? (
        <div className="space-y-6">
          {!initialLoaded && (
            <div className="py-12 text-center text-text-muted text-sm">Loading…</div>
          )}
          {initialLoaded && filtered.length === 0 && (
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
          {!initialLoaded && (
            <div className="col-span-full py-12 text-center text-text-muted text-sm">Loading…</div>
          )}
          {initialLoaded && filtered.length === 0 && (
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

      {showAutoremoveAll && (
        <AutoremoveAllModal
          servers={serversWithAutoremove}
          onClose={() => { setShowAutoremoveAll(false); load() }}
        />
      )}

      {showRollingReboot && (
        <RollingRebootModal
          servers={serversNeedingReboot}
          onClose={() => { setShowRollingReboot(false); load() }}
        />
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
// ---------------------------------------------------------------------------
// Fleet-wide pending updates modal
// ---------------------------------------------------------------------------
function UpdatesSummaryModal({ servers, onClose }: { servers: Server[]; onClose: () => void }) {
  // Sort: most security updates first, then by total update count
  const sorted = [...servers].sort((a, b) => {
    const secDiff = (b.latest_check?.security_packages ?? 0) - (a.latest_check?.security_packages ?? 0)
    if (secDiff !== 0) return secDiff
    return (b.latest_check?.packages_available ?? 0) - (a.latest_check?.packages_available ?? 0)
  })

  const totalPkgs = servers.reduce((sum, s) => sum + (s.latest_check?.packages_available ?? 0), 0)
  const totalSec = servers.reduce((sum, s) => sum + (s.latest_check?.security_packages ?? 0), 0)

  // Fetch packages for each server as the modal opens
  const [pkgMap, setPkgMap] = useState<Record<number, PackageInfo[] | null>>({})

  useEffect(() => {
    let cancelled = false
    async function fetchAll() {
      for (const s of sorted) {
        try {
          const res = await serversApi.packages(s.id)
          if (!cancelled) {
            setPkgMap(prev => ({ ...prev, [s.id]: res.packages }))
          }
        } catch {
          if (!cancelled) setPkgMap(prev => ({ ...prev, [s.id]: null }))
        }
      }
    }
    fetchAll()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-text-primary font-medium">Pending Updates</span>
            <span className="text-xs text-text-muted font-mono">
              {servers.length} server{servers.length !== 1 ? 's' : ''} · {totalPkgs} package{totalPkgs !== 1 ? 's' : ''}
              {totalSec > 0 && <span className="text-red ml-2">· {totalSec} security</span>}
            </span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors text-lg leading-none">×</button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 divide-y divide-border/40">
          {sorted.map(s => {
            const c = s.latest_check!
            const pkgs = pkgMap[s.id]
            const loading = !(s.id in pkgMap)
            const secPkgs = pkgs?.filter(p => p.is_security).sort((a, b) => a.name.localeCompare(b.name)) ?? []
            const regPkgs = pkgs?.filter(p => !p.is_security).sort((a, b) => a.name.localeCompare(b.name)) ?? []

            return (
              <div key={s.id} className="px-4 py-3 space-y-2">
                {/* Server header */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    to={`/servers/${s.id}`}
                    onClick={onClose}
                    className="font-mono text-sm font-medium text-text-primary hover:text-cyan transition-colors"
                  >
                    {s.name}
                  </Link>
                  <span className="text-xs text-text-muted font-mono">{s.hostname}</span>
                  {s.group_name && (
                    <span
                      className="badge text-xs"
                      style={{ background: (s.group_color || '#3b82f6') + '22', color: s.group_color || '#3b82f6', border: `1px solid ${s.group_color || '#3b82f6'}44` }}
                    >
                      {s.group_name}
                    </span>
                  )}
                  <span className="text-xs font-mono text-amber ml-auto shrink-0">
                    {c.packages_available} update{c.packages_available !== 1 ? 's' : ''}
                    {c.security_packages > 0 && <span className="text-red ml-1">· {c.security_packages} security</span>}
                  </span>
                </div>

                {/* Flags */}
                {(c.reboot_required || c.held_packages > 0 || c.autoremove_count > 0) && (
                  <div className="flex gap-1 flex-wrap">
                    {c.reboot_required && <span className="badge bg-amber/10 text-amber border border-amber/30 text-xs">↻ reboot required</span>}
                    {c.held_packages > 0 && <span className="badge bg-blue/10 text-blue border border-blue/30 text-xs">{c.held_packages} held</span>}
                    {c.autoremove_count > 0 && <span className="badge bg-surface-2 text-text-muted border border-border text-xs">{c.autoremove_count} autoremovable</span>}
                  </div>
                )}

                {/* Package list */}
                {loading && (
                  <div className="text-xs text-text-muted font-mono animate-pulse">Loading packages…</div>
                )}
                {pkgs === null && (
                  <div className="text-xs text-red font-mono">Failed to load package list</div>
                )}
                {pkgs && pkgs.length === 0 && (
                  <div className="text-xs text-text-muted font-mono">No package details available</div>
                )}
                {pkgs && pkgs.length > 0 && (
                  <div className="space-y-0.5">
                    {secPkgs.map(p => (
                      <div key={p.name} className="flex items-baseline gap-2 text-xs font-mono py-0.5 px-2 rounded bg-red/5">
                        <span className="text-red shrink-0">🔒</span>
                        <span className="text-text-primary font-medium">{p.name}</span>
                        <span className="text-text-muted shrink-0">{p.current_version} → <span className="text-green">{p.available_version}</span></span>
                        {p.is_phased && <span className="badge bg-blue/10 text-blue border border-blue/30 text-xs shrink-0">phased</span>}
                      </div>
                    ))}
                    {regPkgs.map(p => (
                      <div key={p.name} className="flex items-baseline gap-2 text-xs font-mono py-0.5 px-2 rounded hover:bg-surface-2/40">
                        <span className="w-4 shrink-0" />
                        <span className="text-text-primary">{p.name}</span>
                        <span className="text-text-muted shrink-0">{p.current_version} → <span className="text-text-primary">{p.available_version}</span></span>
                        {p.is_phased && <span className="badge bg-blue/10 text-blue border border-blue/30 text-xs shrink-0">phased</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Reboot confirmation button — uses a modal overlay
// ---------------------------------------------------------------------------
function RebootButton({ serverId, serverName, className = '' }: {
  serverId: number
  serverName: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [rebooting, setRebooting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function doReboot() {
    setRebooting(true)
    setResult(null)
    try {
      const res = await serversApi.reboot(serverId)
      setResult(res.success ? 'Reboot command sent.' : res.detail)
    } catch (err: unknown) {
      setResult((err as Error).message)
    } finally {
      setRebooting(false)
      setOpen(false)
    }
  }

  return (
    <>
      <span className="flex items-center gap-1">
        <button
          onClick={() => setOpen(true)}
          disabled={rebooting}
          className={`btn-secondary text-xs py-0.5 text-amber border-amber/40 hover:border-amber/70 ${className}`}
        >
          {rebooting ? 'Rebooting…' : '↻ Reboot'}
        </button>
        {result && <span className="text-xs font-mono text-text-muted">{result}</span>}
      </span>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-surface border border-border rounded-lg p-6 shadow-xl max-w-sm w-full mx-4 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">↻</span>
              <div>
                <h3 className="text-text-primary font-medium">Confirm Reboot</h3>
                <p className="text-text-muted text-sm">This will immediately reboot <span className="font-mono text-amber">{serverName}</span>.</p>
              </div>
            </div>
            <p className="text-xs text-text-muted">Any running processes will be interrupted. Make sure no critical operations are in progress.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setOpen(false)} className="btn-secondary">Cancel</button>
              <button onClick={doReboot} disabled={rebooting} className="btn-danger">
                {rebooting ? 'Rebooting…' : 'Yes, reboot now'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
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
      className={`card p-3 flex flex-col gap-2 transition-colors cursor-pointer ${!s.is_enabled ? 'opacity-50' : s.is_reachable === false ? 'opacity-60' : ''}`}
      style={primaryGroupColor ? { borderLeft: `3px solid ${s.is_reachable === false ? '#ef4444' : primaryGroupColor}66` } : (s.is_reachable === false ? { borderLeft: '3px solid #ef444466' } : undefined)}
      onClick={() => navigate(`/servers/${s.id}`)}
    >
      {s.is_enabled && s.is_reachable === false && (
        <div className="flex items-center gap-1.5 text-red text-[10px] font-mono bg-red/10 border border-red/20 rounded px-2 py-0.5 -mx-1 -mt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-red inline-block shrink-0" />
          offline — TCP unreachable
        </div>
      )}
      {/* Two-column body: left = identity, right = status/stats */}
      <div className="flex items-start gap-2">
        {/* Left: name, hostname, OS */}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <StatusDot status={status} />
            <span className="font-mono text-sm text-text-primary truncate">{s.name}</span>
          </div>
          <div className="flex items-center font-mono text-xs text-text-muted truncate group/host">
            {reachable === false && <span title="Unreachable" className="w-2 h-2 rounded-full bg-red inline-block mr-1 shrink-0" />}
            {reachable === true && <span title="Reachable" className="w-2 h-2 rounded-full bg-green inline-block mr-1 shrink-0" />}
            {(reachable === null || reachable === undefined) && <span className="w-2 h-2 rounded-full bg-gray-600 inline-block mr-1 shrink-0" />}
            <span className="truncate">{s.hostname}</span>
            <span className="ml-1.5 opacity-0 group-hover/host:opacity-100 transition-opacity shrink-0" onClick={e => e.stopPropagation()}>
              <CopySshButton username={s.username} hostname={s.hostname} port={s.ssh_port} />
            </span>
          </div>
          {s.os_info && (
            <div className="text-xs text-text-muted font-mono truncate">
              <span className="mr-1">{osIcon(s.os_info)}</span>{s.os_info}
            </div>
          )}
        </div>

        {/* Right: update count, stats */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          {/* Update count or status */}
          {c && c.packages_available > 0 ? (
            <div className="text-right leading-none mt-1">
              {c.security_packages > 0 ? (
                <>
                  <div>
                    <span className="text-2xl font-mono font-bold text-red">{c.security_packages}</span>
                    <span className="text-[10px] text-red/70 ml-1">sec</span>
                  </div>
                  <div className="mt-0.5">
                    <span className="text-sm font-mono text-amber/80">{c.packages_available}</span>
                    <span className="text-[10px] text-text-muted ml-1">upd</span>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-2xl font-mono font-medium text-amber">{c.packages_available}</span>
                  <span className="text-[10px] text-text-muted ml-1">upd</span>
                </>
              )}
            </div>
          ) : c?.packages_available === 0 && c?.status === 'success' ? (
            <span className="text-xs text-green font-mono mt-1">✓ ok</span>
          ) : c?.status === 'error' ? (
            <span className="text-xs text-red font-mono mt-1" title={c.error_message || ''}>✗ err</span>
          ) : null}

          {/* Hardware stats */}
          {(s.cpu_count != null || memGb != null || s.virt_type) && (
            <div className="text-[10px] text-text-muted font-mono text-right leading-tight mt-0.5">
              {s.cpu_count != null && <div>{s.cpu_count} CPU</div>}
              {memGb != null && <div>{memGb} GB</div>}
              {s.virt_type && <div className="text-text-muted/60 truncate max-w-[80px]">{s.virt_type}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Bottom section: label tags, then actionable status strip */}
      {(() => {
        const groups = (s.groups ?? []).length > 0 ? s.groups! : (s.group_name ? [{ id: -1, name: s.group_name, color: s.group_color ?? '#3b82f6' }] : [])
        const allLabels = [
          ...groups.map(g => ({ key: `g${g.id}`, name: g.name, color: g.color || '#3b82f6' })),
          ...(s.tags ?? []).map(t => ({ key: `t${t.id}`, name: t.name, color: t.color || '#6366f1' })),
        ]
        const shownLabels = allLabels.slice(0, 4)
        const overflow = allLabels.length - shownLabels.length

        const statusItems: React.ReactNode[] = [
          s.is_docker_host
            ? <span key="docker" className="text-purple" title="Docker host — upgrading container runtimes may disrupt this dashboard">🐳 docker</span>
            : null,
          s.apt_proxy
            ? <span key="proxy" className="text-cyan" title={`apt proxy: ${s.apt_proxy === 'auto-apt-proxy' ? 'auto-apt-proxy (DNS)' : s.apt_proxy}`}>⚡ proxy</span>
            : null,
          c?.reboot_required
            ? <span key="reboot" className="text-amber">↻ reboot</span>
            : null,
          s.eeprom_update_available === 'update_available'
            ? <span key="eeprom" className="text-amber" title="EEPROM firmware update available">⬆ eeprom</span>
            : null,
          s.eeprom_update_available === 'update_staged'
            ? <span key="eeprom-s" className="text-blue" title="EEPROM update staged — reboot to apply">⬆ eeprom*</span>
            : null,
          (s.auto_security_updates === 'disabled' || s.auto_security_updates === 'not_installed')
            ? <span key="autosec" className="text-red/80" title={s.auto_security_updates === 'not_installed' ? 'unattended-upgrades not installed' : 'Auto security updates disabled'}>🛡 no-auto</span>
            : null,
          c && c.held_packages > 0
            ? <span key="held" className="text-blue">{c.held_packages} held</span>
            : null,
          c && c.autoremove_count > 0
            ? <button key="remove" className="text-amber/80 hover:text-amber" onClick={e => { e.stopPropagation(); navigate(`/servers/${s.id}`, { state: { tab: 'Packages' } }) }}>
                {c.autoremove_count} removable
              </button>
            : null,
          (() => {
            // Kernel age badge (issue #44): show when running kernel is >60d old
            if (!s.kernel_install_date) return null
            const ageDays = Math.floor((Date.now() - new Date(s.kernel_install_date).getTime()) / 86400000)
            if (ageDays < 60) return null
            const colorClass = ageDays >= 180 ? 'text-red' : 'text-amber/70'
            return <span key="kernel-age" className={colorClass} title={`Running kernel installed ${ageDays} days ago`}>🐧 {ageDays}d</span>
          })(),
          (() => {
            // OS EOL countdown badge (issue #57): show when EOL < 365 days away
            if (s.os_eol_days_remaining == null || !s.os_eol_severity) return null
            if (s.os_eol_severity === 'unknown') return null
            if (s.os_eol_days_remaining >= 365) return null
            const colorClass =
              s.os_eol_severity === 'expired' || s.os_eol_severity === 'alert'
                ? 'text-red'
                : s.os_eol_severity === 'warning'
                  ? 'text-amber'
                  : 'text-cyan'
            const isUbuntu = (s.os_info || '').toLowerCase().includes('ubuntu')
            const dateStr = s.os_eol_date || 'unknown'
            const tip = s.os_eol_days_remaining < 0
              ? `OS reached end-of-life on ${dateStr} (${Math.abs(s.os_eol_days_remaining)} days ago)${isUbuntu ? ' — ESM available via Ubuntu Pro' : ''}`
              : `OS end-of-life on ${dateStr} (${s.os_eol_days_remaining} days)${isUbuntu ? ' — ESM available via Ubuntu Pro' : ''}`
            const label = s.os_eol_days_remaining < 0
              ? `🕒 EOL`
              : `🕒 ${s.os_eol_days_remaining}d`
            return <span key="os-eol" className={colorClass} title={tip}>{label}</span>
          })(),
          (() => {
            // /boot disk space badge (issue #43): warn at <100MB OR <10% free
            if (s.boot_free_mb == null || s.boot_total_mb == null) return null
            const pct = s.boot_total_mb > 0 ? (s.boot_free_mb / s.boot_total_mb) * 100 : 100
            if (s.boot_free_mb >= 100 && pct >= 10) return null
            return <span key="boot-low" className="text-red" title={`/boot has only ${s.boot_free_mb} MB free (${pct.toFixed(0)}% of ${s.boot_total_mb} MB) — run autoremove to clear old kernels`}>💾 /boot {s.boot_free_mb}M</span>
          })(),
        ].filter(Boolean)

        if (!shownLabels.length && !overflow && !statusItems.length) return null

        return (
          <div className="space-y-1">
            {/* Label row: groups + tags, capped at 4 */}
            {(shownLabels.length > 0 || overflow > 0) && (
              <div className="flex gap-1 flex-nowrap overflow-hidden items-center">
                {shownLabels.map(item => (
                  <span key={item.key} className="badge text-xs shrink-0"
                    style={{ background: item.color + '22', color: item.color, border: `1px solid ${item.color}44` }}>
                    {item.name}
                  </span>
                ))}
                {overflow > 0 && (
                  <span className="text-[10px] text-text-muted font-mono shrink-0">+{overflow}</span>
                )}
              </div>
            )}
            {/* Status strip: plain colored text, no borders — only actionable items */}
            {statusItems.length > 0 && (
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-mono">
                {statusItems}
              </div>
            )}
          </div>
        )
      })()}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-border/50 mt-auto">
        <span
          className={`text-xs font-mono ${isStale(c?.checked_at, 24) ? 'text-amber' : isStale(c?.checked_at, 12) ? 'text-amber/70' : 'text-text-muted'}`}
          title={isStale(c?.checked_at, 24) ? 'Last check was over 24h ago' : undefined}
        >
          {relativeTime(c?.checked_at || null)}
          {isStale(c?.checked_at, 24) && ' ⚠'}
        </span>
        <div className="flex gap-1 flex-wrap justify-end items-center">
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

// ---------------------------------------------------------------------------
// apt-cacher-ng monitoring widget
// ---------------------------------------------------------------------------

function HitBar({ pct }: { pct: number }) {
  const color = pct >= 50 ? '#22c55e' : pct >= 25 ? '#f59e0b' : '#ef4444'
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <div className="h-1.5 flex-1 bg-surface-2 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="font-mono text-xs shrink-0" style={{ color }}>{pct}%</span>
    </div>
  )
}

function AptCacheCard({ s }: { s: AptCacheStats }) {
  const today = s.daily[0] as AptCacheDailyRow | undefined
  const shown = s.daily.slice(0, 7)

  return (
    <div className="card p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono text-sm text-text-primary">{s.label}</span>
          <span className="ml-2 text-xs text-text-muted font-mono">{s.host}:{s.port}</span>
        </div>
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${s.ok ? 'text-green bg-green/10' : 'text-red bg-red/10'}`}>
          {s.ok ? 'online' : 'offline'}
        </span>
      </div>

      {!s.ok && <p className="text-xs text-red">{s.error ?? 'Unreachable'}</p>}

      {s.ok && (
        <>
          {/* Transfer totals */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-surface-2 rounded p-2 space-y-0.5">
              <p className="text-text-muted uppercase tracking-wide text-[10px]">Fetched from upstream</p>
              <p className="font-mono text-text-primary">{s.data_fetched_recent || s.data_fetched_startup || '—'}</p>
              {s.data_fetched_startup && s.data_fetched_recent && (
                <p className="text-text-muted text-[10px]">all-time: {s.data_fetched_startup}</p>
              )}
            </div>
            <div className="bg-surface-2 rounded p-2 space-y-0.5">
              <p className="text-text-muted uppercase tracking-wide text-[10px]">Served to clients</p>
              <p className="font-mono text-text-primary">{s.data_served_recent || s.data_served_startup || '—'}</p>
              {s.data_served_startup && s.data_served_recent && (
                <p className="text-text-muted text-[10px]">all-time: {s.data_served_startup}</p>
              )}
            </div>
          </div>

          {/* Today's quick stats */}
          {today && (
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-text-muted">Today ({today.date})</p>
              <HitBar pct={today.hit_req_pct} />
              <div className="flex gap-3 text-xs text-text-muted font-mono">
                <span className="text-green">{today.hit_requests.toLocaleString()} hits</span>
                <span className="text-amber">{today.miss_requests.toLocaleString()} misses</span>
                <span>{today.total_requests.toLocaleString()} total</span>
              </div>
              <div className="flex gap-3 text-xs text-text-muted font-mono">
                <span>↑ {today.hits_data}</span>
                <span className="text-text-muted/60">miss: {today.misses_data}</span>
                <span>total: {today.total_data}</span>
              </div>
            </div>
          )}

          {/* 7-day table */}
          {shown.length > 1 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-text-muted mb-1">Last {shown.length} days</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted text-[10px] uppercase">
                    <th className="text-left py-0.5 pr-2 font-normal">Date</th>
                    <th className="text-left py-0.5 pr-2 font-normal">Hit rate</th>
                    <th className="text-right py-0.5 pr-2 font-normal">Reqs</th>
                    <th className="text-right py-0.5 font-normal">Data</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/20">
                  {shown.map((row, i) => (
                    <tr key={row.date} className={i === 0 ? 'text-text-primary' : 'text-text-muted'}>
                      <td className="py-0.5 pr-2 font-mono">{row.date}</td>
                      <td className="py-0.5 pr-2 w-28"><HitBar pct={row.hit_req_pct} /></td>
                      <td className="py-0.5 pr-2 text-right font-mono">{row.total_requests.toLocaleString()}</td>
                      <td className="py-0.5 text-right font-mono">{row.total_data}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function useAptCacheData() {
  const [servers, setServers] = useState<AptCacheStats[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const data = await aptcacheApi.allStats()
      setServers(data)
    } catch {
      // silently fail if no servers configured
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  return { servers, loading, reload: load }
}

function AptCacheDetailModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card w-full max-w-4xl max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="font-mono text-sm font-medium text-text-primary">apt-cacher-ng</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg leading-none">✕</button>
        </div>
        <div className="overflow-y-auto p-4">
          <AptCacheWidget />
        </div>
      </div>
    </div>,
    document.body,
  )
}

function AptCacheCompactCards({ onOpenDetail }: { onOpenDetail: () => void }) {
  const { servers, loading } = useAptCacheData()
  if (loading || servers.length === 0) return null

  return (
    <>
      {servers.map(s => {
        const today = (s.daily ?? [])[0] as AptCacheDailyRow | undefined
        const pct = today?.hit_req_pct ?? null
        const color = !s.ok
          ? '#ef4444'
          : pct == null ? '#22c55e'
          : pct >= 50 ? '#22c55e' : pct >= 25 ? '#f59e0b' : '#ef4444'
        return (
          <div key={s.id} className="card px-3 py-2 space-y-1 cursor-pointer hover:border-text-muted transition-colors" style={{ minWidth: 140 }} title={`${s.host}:${s.port}${!s.ok ? ` — ${s.error}` : ''} — click for details`} onClick={onOpenDetail}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-text-muted truncate">{s.label}</span>
              <span className={`text-[10px] font-mono ${s.ok ? 'text-green' : 'text-red'}`}>{s.ok ? 'online' : 'offline'}</span>
            </div>
            {!s.ok ? (
              <div className="text-xs text-red font-mono">unreachable</div>
            ) : pct != null ? (
              <>
                <div className="flex items-baseline gap-1">
                  <span className="text-xl font-mono font-bold" style={{ color }}>{pct}%</span>
                  <span className="text-[10px] text-text-muted">hit rate</span>
                </div>
                <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
                </div>
                <div className="flex gap-2 text-[10px] font-mono">
                  <span className="text-green">{today!.hit_requests.toLocaleString()} hits</span>
                  <span className="text-amber">{today!.miss_requests.toLocaleString()} miss</span>
                </div>
                {s.data_served_recent && (
                  <div className="text-[10px] text-text-muted font-mono">served {s.data_served_recent}</div>
                )}
              </>
            ) : (s.data_served_recent || s.data_served_startup) ? (
              /* Online but no per-request log data — show transfer totals instead */
              <>
                <div className="text-[10px] text-text-muted uppercase tracking-wide">served to clients</div>
                <div className="text-sm font-mono font-medium text-text-primary">
                  {s.data_served_recent || s.data_served_startup}
                </div>
                {s.data_fetched_recent && (
                  <div className="text-[10px] text-text-muted font-mono">fetched {s.data_fetched_recent}</div>
                )}
              </>
            ) : (
              <div className="text-xs text-text-muted font-mono">no stats yet</div>
            )}
          </div>
        )
      })}
    </>
  )
}

export function AptCacheWidget() {
  const { servers, loading, reload } = useAptCacheData()

  if (loading || servers.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs uppercase tracking-wide text-text-muted font-medium">apt-cacher-ng</h2>
        <button onClick={reload} className="text-text-muted/50 hover:text-text-muted text-xs transition-colors" title="Refresh">↻</button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        {servers.map(s => <AptCacheCard key={s.id} s={s} />)}
      </div>
    </div>
  )
}
