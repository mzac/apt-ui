import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { security as securityApi, groups as groupsApi, tags as tagsApi, scheduler as schedulerApi, createSelectiveUpgradeWebSocket } from '@/api/client'
import type { RemediationPlan, RemediationPlanServer, RemediationServerEntry, RemediationMatchedPackage } from '@/api/client'
import type {
  CveInventoryRow,
  CveSeverity,
  CveSummary,
  ServerGroup,
  Tag,
} from '@/types'
import { formatDate } from '@/utils/datetime'
import Convert from 'ansi-to-html'

const ansiConvert = new Convert({ escapeXML: true })

// ---------------------------------------------------------------------------
// Remediation planner (issue #62) types + fetch helper
//
// These extend the shared CveInventoryRow/CveSummary shapes (frontend/src/types/index.ts)
// with fields backend/routers/security.py now returns (mttr_hours, mttr_note,
// median_mttr_hours, mttr_sample_size) and the new GET /api/security/remediation/{id}
// response. Declared locally rather than in types/index.ts / api/client.ts since another
// change is landing in those files in parallel with this one — the runtime payload already
// carries these fields, this just describes them for this page.
// ---------------------------------------------------------------------------

type CveRow = CveInventoryRow & {
  mttr_hours: number | null
  mttr_note: string | null
}

type SummaryExt = CveSummary & {
  median_mttr_hours: number | null
  mttr_sample_size: number
}

function formatMttr(hours: number): string {
  if (hours < 24) return `${hours}h`
  return `${(hours / 24).toFixed(1)}d`
}

type StatusFilter = 'pending' | 'fixed' | 'all'
type ViewMode = 'cve' | 'server'

const SEVERITIES: CveSeverity[] = ['critical', 'high', 'medium', 'low', 'unknown']

const SEV_RANK: Record<CveSeverity, number> = {
  critical: 4, high: 3, medium: 2, low: 1, unknown: 0,
}

const SEV_BADGE: Record<CveSeverity, string> = {
  critical: 'bg-red/15 text-red border-red/40',
  high: 'bg-orange-500/10 text-orange-400 border-orange-500/40',
  medium: 'bg-amber/10 text-amber border-amber/30',
  low: 'bg-cyan/10 text-cyan border-cyan/30',
  unknown: 'bg-surface-2 text-text-muted border-border',
}

function downloadCsv(filename: string, headers: string[], rows: (string | number | boolean | null)[][]) {
  const escape = (v: string | number | boolean | null) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function SeverityBadge({ severity }: { severity: CveSeverity }) {
  return (
    <span className={`badge border text-[10px] uppercase tracking-wide font-mono ${SEV_BADGE[severity]}`}>
      {severity}
    </span>
  )
}

function StatusBadge({ status }: { status: 'pending' | 'partial' | 'fixed' }) {
  const cls =
    status === 'pending' ? 'bg-red/10 text-red border-red/30'
    : status === 'partial' ? 'bg-amber/10 text-amber border-amber/30'
    : 'bg-green/10 text-green border-green/30'
  return (
    <span className={`badge border text-[10px] uppercase tracking-wide font-mono ${cls}`}>
      {status}
    </span>
  )
}

export default function Security() {
  const [view, setView] = useState<ViewMode>('cve')
  const [data, setData] = useState<CveRow[] | null>(null)
  const [summary, setSummary] = useState<SummaryExt | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')
  const [severityFilter, setSeverityFilter] = useState<Set<CveSeverity>>(new Set())
  const [groupId, setGroupId] = useState<number | ''>('')
  const [tag, setTag] = useState<string>('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')

  // Lookups for dropdowns
  const [groups, setGroups] = useState<ServerGroup[]>([])
  const [tags, setTags] = useState<Tag[]>([])

  useEffect(() => {
    groupsApi.list().then(setGroups).catch(() => {})
    tagsApi.list().then(setTags).catch(() => {})
    securityApi.summary().then(s => setSummary(s as unknown as SummaryExt)).catch(() => {})
  }, [])

  // `cancelled` guards against an out-of-order response: rapidly toggling
  // filters (e.g. status pending → fixed → pending) could otherwise let an
  // older response resolve after a newer one and paint a table that doesn't
  // match the currently-selected filters.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    securityApi
      .list({
        status: statusFilter,
        severity: severityFilter.size > 0 ? [...severityFilter].join(',') : undefined,
        group_id: groupId === '' ? undefined : groupId,
        tag: tag || undefined,
        since: since || undefined,
        until: until || undefined,
      })
      .then(rows => { if (!cancelled) setData(rows as unknown as CveRow[]) })
      .catch(e => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load CVEs')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [statusFilter, severityFilter, groupId, tag, since, until])

  function toggleSeverity(sev: CveSeverity) {
    setSeverityFilter(prev => {
      const next = new Set(prev)
      next.has(sev) ? next.delete(sev) : next.add(sev)
      return next
    })
  }

  function clearFilters() {
    setStatusFilter('pending')
    setSeverityFilter(new Set())
    setGroupId('')
    setTag('')
    setSince('')
    setUntil('')
  }

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-mono text-text-primary">Security · Fleet CVE Inventory</h1>
        <p className="text-sm text-text-muted">
          Pivot of every Ubuntu Security Notice (USN) matched to a pending package across the fleet.{' '}
          <span className="text-text-muted/70">CVE data is refreshed daily from <span className="font-mono">usn.ubuntu.com</span>.</span>
        </p>
      </div>

      {/* Header counters */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <CounterTile label="Open CVEs" value={summary?.open_total ?? '—'} accent="text-text-primary" />
        <CounterTile
          label="Critical"
          value={summary?.critical ?? '—'}
          accent={summary && summary.critical > 0 ? 'text-red' : 'text-text-muted'}
        />
        <CounterTile
          label="High"
          value={summary?.high ?? '—'}
          accent={summary && summary.high > 0 ? 'text-orange-400' : 'text-text-muted'}
        />
        <CounterTile
          label="Fixed last 7d"
          value={summary?.fixed_last_7d ?? '—'}
          accent={summary && summary.fixed_last_7d > 0 ? 'text-green' : 'text-text-muted'}
        />
        <CounterTile
          label="Median MTTR"
          value={summary?.median_mttr_hours != null ? formatMttr(summary.median_mttr_hours) : '—'}
          accent="text-cyan"
          title={
            summary && summary.mttr_sample_size > 0
              ? `Based on ${summary.mttr_sample_size} resolved CVE${summary.mttr_sample_size !== 1 ? 's' : ''} with provable resolution times`
              : 'No resolved CVEs with a provable resolution time in the retention window yet'
          }
        />
      </div>

      {/* Filters */}
      <div className="card p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Status segmented control */}
          <div className="inline-flex rounded border border-border overflow-hidden text-xs font-mono">
            {(['pending', 'fixed', 'all'] as StatusFilter[]).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 transition-colors ${
                  statusFilter === s
                    ? 'bg-surface-2 text-text-primary'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Severity chips */}
          <div className="flex flex-wrap gap-1.5">
            {SEVERITIES.map(sev => (
              <button
                key={sev}
                onClick={() => toggleSeverity(sev)}
                className={`badge border text-[10px] uppercase tracking-wide font-mono cursor-pointer transition-opacity ${
                  SEV_BADGE[sev]
                } ${severityFilter.size > 0 && !severityFilter.has(sev) ? 'opacity-30' : ''}`}
              >
                {sev}
              </button>
            ))}
          </div>

          {/* Group dropdown */}
          <select
            value={groupId}
            onChange={e => setGroupId(e.target.value === '' ? '' : parseInt(e.target.value))}
            className="input text-xs w-36"
          >
            <option value="">All groups</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>

          {/* Tag dropdown */}
          <select
            value={tag}
            onChange={e => setTag(e.target.value)}
            className="input text-xs w-36"
          >
            <option value="">All tags</option>
            {tags.map(t => (
              <option key={t.id} value={t.name}>{t.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-text-muted font-mono">First seen:</label>
          <input
            type="date"
            value={since}
            onChange={e => setSince(e.target.value)}
            className="input text-xs w-36"
            title="From (inclusive)"
          />
          <span className="text-text-muted text-xs">→</span>
          <input
            type="date"
            value={until}
            onChange={e => setUntil(e.target.value)}
            className="input text-xs w-36"
            title="To (inclusive)"
          />
          <button onClick={clearFilters} className="text-xs text-text-muted hover:text-text-primary">
            Clear filters
          </button>

          {/* View toggle + export */}
          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded border border-border overflow-hidden text-xs font-mono">
              <button
                onClick={() => setView('cve')}
                className={`px-3 py-1.5 transition-colors ${view === 'cve' ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
              >
                CVE → Servers
              </button>
              <button
                onClick={() => setView('server')}
                className={`px-3 py-1.5 transition-colors ${view === 'server' ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
              >
                Server → CVEs
              </button>
            </div>
            <button
              onClick={() => exportCsv(view, data ?? [])}
              disabled={!data || data.length === 0}
              className="btn-secondary text-xs disabled:opacity-50"
            >
              ↓ CSV
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="card border-red/40 bg-red/5 p-3 text-sm text-red font-mono">{error}</div>
      )}

      {loading && !data ? (
        <p className="text-text-muted text-sm">Loading…</p>
      ) : data && data.length === 0 ? (
        <div className="card p-8 text-center text-text-muted text-sm">
          No CVEs match the current filters.
        </div>
      ) : data ? (
        view === 'cve' ? <CveTable rows={data} /> : <ServerTable rows={data} />
      ) : null}
    </div>
  )
}

function CounterTile({ label, value, accent, title }: { label: string; value: number | string; accent: string; title?: string }) {
  return (
    <div className="card p-3" title={title}>
      <div className="text-[10px] text-text-muted uppercase tracking-wide font-mono">{label}</div>
      <div className={`text-2xl font-mono mt-0.5 ${accent}`}>{value}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CVE → Servers table (default view)
// ---------------------------------------------------------------------------

function CveTable({ rows }: { rows: CveRow[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-border text-text-muted">
            <th className="text-left px-3 py-2 font-normal w-6"></th>
            <th className="text-left px-3 py-2 font-normal">CVE / USN</th>
            <th className="text-left px-3 py-2 font-normal">Severity</th>
            <th className="text-left px-3 py-2 font-normal">Package</th>
            <th className="text-left px-3 py-2 font-normal">Fixed in</th>
            <th className="text-left px-3 py-2 font-normal">First seen</th>
            <th className="text-center px-3 py-2 font-normal">Status</th>
            <th className="text-right px-3 py-2 font-normal">Servers</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {rows.map(r => {
            const key = `${r.cve_id}|${r.package}`
            const isOpen = expanded.has(key)
            return (
              <ExpandableCveRow
                key={key}
                row={r}
                rowKey={key}
                isOpen={isOpen}
                onToggle={() => toggle(key)}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ExpandableCveRow({
  row, rowKey, isOpen, onToggle,
}: {
  row: CveRow
  rowKey: string
  isOpen: boolean
  onToggle: () => void
}) {
  const cveLink = row.cve_id.startsWith('CVE-')
    ? `https://ubuntu.com/security/${row.cve_id}`
    : row.url
  // The remediation endpoint accepts either form; prefer the real CVE id when we have one.
  const remediationIdentifier = row.cve_id.startsWith('CVE-') ? row.cve_id : (row.usn_ids[0] || row.cve_id)

  return (
    <>
      <tr
        className="hover:bg-surface/50 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-1.5 text-text-muted/70 select-none">{isOpen ? '▾' : '▸'}</td>
        <td className="px-3 py-1.5">
          <a
            href={cveLink}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-cyan hover:underline"
          >
            {row.cve_id}
          </a>
          {row.usn_ids.length > 0 && (
            <span className="ml-2 text-text-muted/70 text-[10px]">
              {row.usn_ids.slice(0, 2).map((u, i) => (
                <span key={u}>
                  {i > 0 && ', '}
                  <a
                    href={`https://ubuntu.com/security/notices/${u}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="hover:text-cyan hover:underline"
                  >
                    {u}
                  </a>
                </span>
              ))}
              {row.usn_ids.length > 2 && <span> +{row.usn_ids.length - 2}</span>}
            </span>
          )}
        </td>
        <td className="px-3 py-1.5"><SeverityBadge severity={row.severity} /></td>
        <td className="px-3 py-1.5 text-text-primary">{row.package}</td>
        <td className="px-3 py-1.5 text-text-muted">{row.fixed_version || '—'}</td>
        <td className="px-3 py-1.5 text-text-muted">
          {formatDate(row.first_seen_in_fleet)}
          {row.status === 'fixed' && (
            row.mttr_hours != null ? (
              <span className="ml-1.5 text-green/80 text-[10px]" title="Time to remediate — first seen to fully resolved fleet-wide">
                ✓ {formatMttr(row.mttr_hours)}
              </span>
            ) : row.mttr_note ? (
              <span className="ml-1.5 text-text-muted/50 text-[10px]" title={row.mttr_note}>MTTR n/a</span>
            ) : null
          )}
        </td>
        <td className="px-3 py-1.5 text-center"><StatusBadge status={row.status} /></td>
        <td className="px-3 py-1.5 text-right">
          <span className="text-text-primary">{row.pending_count}</span>
          {row.affected_count !== row.pending_count && (
            <span className="text-text-muted/60"> / {row.affected_count}</span>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-surface-2/40">
          <td></td>
          <td colSpan={7} className="px-3 py-3">
            <div className="text-[10px] text-text-muted uppercase tracking-wide mb-2">
              Affected servers · {row.affected_servers.length}
            </div>
            {row.affected_servers.length === 0 ? (
              <p className="text-text-muted text-xs">No servers currently affected.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-text-muted/80 border-b border-border/40">
                      <th className="text-left px-2 py-1 font-normal">Server</th>
                      <th className="text-left px-2 py-1 font-normal">Hostname</th>
                      <th className="text-left px-2 py-1 font-normal">Installed</th>
                      <th className="text-left px-2 py-1 font-normal">Fixed in</th>
                      <th className="text-center px-2 py-1 font-normal">Status</th>
                      <th className="text-right px-2 py-1 font-normal">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.affected_servers.map(s => (
                      <tr key={`${rowKey}-${s.id}`} className="border-b border-border/20 last:border-0">
                        <td className="px-2 py-1 text-text-primary">{s.name}</td>
                        <td className="px-2 py-1 text-text-muted">{s.hostname}</td>
                        <td className="px-2 py-1 text-text-muted">{s.installed_version || '—'}</td>
                        <td className="px-2 py-1 text-text-muted">{s.fixed_version || row.fixed_version || '—'}</td>
                        <td className="px-2 py-1 text-center">
                          {s.status === 'pending'
                            ? <span className="text-red">pending</span>
                            : <span className="text-green">fixed</span>}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <Link
                            to={`/servers/${s.id}?tab=packages`}
                            className="text-cyan hover:underline"
                          >
                            View packages →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {row.status !== 'fixed' && (
              <RemediationPanel identifier={remediationIdentifier} rowKey={rowKey} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Remediation planner (issue #62)
//
// Per-server "which pending packages actually fix this CVE/USN, and is that fix even
// available in what apt currently sees as pending" — computed by
// GET /api/security/remediation/{identifier}. "Remediate everywhere" reuses the existing
// per-server selective-upgrade WebSocket (createSelectiveUpgradeWebSocket ->
// /api/ws/upgrade-selective/{server_id} -> backend/upgrade_manager.py:
// upgrade_packages_selective) — no new upgrade path.
// ---------------------------------------------------------------------------

function RemediationPanel({ identifier, rowKey }: { identifier: string; rowKey: string }) {
  const [plan, setPlan] = useState<RemediationPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showRemediate, setShowRemediate] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    securityApi.remediation(identifier)
      .then(p => { if (!cancelled) setPlan(p) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load remediation plan') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [identifier])

  return (
    <div className="mt-4 pt-3 border-t border-border/40">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-text-muted uppercase tracking-wide">Remediation plan</div>
        {plan?.found && (plan.remediation_plan?.length ?? 0) > 0 && (
          <button onClick={() => setShowRemediate(true)} className="btn-amber text-xs px-2 py-1">
            Remediate everywhere ({plan.remediation_plan!.length})
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-text-muted text-xs">Loading plan…</p>
      ) : error ? (
        <p className="text-red text-xs">{error}</p>
      ) : !plan?.found ? (
        <p className="text-text-muted text-xs">{plan?.message || 'No remediation data available.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-text-muted/80 border-b border-border/40">
                <th className="text-left px-2 py-1 font-normal">Server</th>
                <th className="text-left px-2 py-1 font-normal">Fix status</th>
                <th className="text-left px-2 py-1 font-normal">Packages / required version</th>
              </tr>
            </thead>
            <tbody>
              {(plan.affected_servers ?? []).map(s => (
                <tr key={`${rowKey}-rem-${s.server_id}`} className="border-b border-border/20 last:border-0 align-top">
                  <td className="px-2 py-1 text-text-primary whitespace-nowrap">{s.name}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    {s.status === 'fix_pending' ? (
                      <span className="text-green">
                        fix pending{s.version_confidence === 'approximate' ? ' (approx. version)' : ''}
                      </span>
                    ) : (
                      <span className="text-text-muted" title={s.note || ''}>blocked / not pending</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-text-muted">
                    {s.matched_packages.length > 0 ? (
                      s.matched_packages.map(p => (
                        <div key={p.name}>
                          <span className="text-text-primary">{p.name}</span>
                          {' '}→ {p.required_fixed_version || '—'}
                        </div>
                      ))
                    ) : (
                      <span className="text-text-muted/60">{s.note}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showRemediate && plan?.remediation_plan && (
        <RemediateEverywhereModal
          identifier={identifier}
          servers={plan.remediation_plan}
          onClose={() => setShowRemediate(false)}
        />
      )}
    </div>
  )
}

function RemediateEverywhereModal({ identifier, servers, onClose }: {
  identifier: string
  servers: RemediationPlanServer[]
  onClose: () => void
}) {
  type ServerRunState = 'queued' | 'running' | 'done' | 'error'
  const [states, setStates] = useState<Record<number, ServerRunState>>(
    () => Object.fromEntries(servers.map(s => [s.server_id, 'queued'])),
  )
  const [lines, setLines] = useState<Record<number, string[]>>({})
  const [started, setStarted] = useState(false)
  const socketsRef = useRef<WebSocket[]>([])
  // Honour the fleet's configured upgrade concurrency. Opening one socket per
  // server at once would run the whole fleet's upgrades simultaneously, which is
  // exactly what upgrade_concurrency exists to prevent.
  const [concurrency, setConcurrency] = useState(5)

  useEffect(() => {
    schedulerApi.status()
      .then(c => { if (c.upgrade_concurrency > 0) setConcurrency(c.upgrade_concurrency) })
      .catch(() => { /* fall back to the conservative default */ })
  }, [])

  useEffect(() => () => { socketsRef.current.forEach(ws => ws.close()) }, [])

  function start() {
    setStarted(true)
    // Simple worker pool: keep at most `concurrency` sockets open, starting the
    // next server only as an earlier one closes.
    const queue = [...servers]

    const launchNext = () => {
      const s = queue.shift()
      if (!s) return
      setStates(prev => ({ ...prev, [s.server_id]: 'running' }))
      let sawTerminal = false
      const ws = createSelectiveUpgradeWebSocket(
        s.server_id,
        { packages: s.packages, allow_phased: false },
        (msg) => {
          if (msg.type === 'output') {
            setLines(prev => ({ ...prev, [s.server_id]: [...(prev[s.server_id] || []), msg.data as string] }))
          } else if (msg.type === 'error' || msg.type === 'skipped') {
            sawTerminal = true
            setStates(prev => ({ ...prev, [s.server_id]: 'error' }))
          } else if (msg.type === 'complete') {
            sawTerminal = true
            const d = msg.data as { success: boolean }
            setStates(prev => ({ ...prev, [s.server_id]: d.success ? 'done' : 'error' }))
          }
        },
        () => {
          if (!sawTerminal) setStates(prev => ({ ...prev, [s.server_id]: 'error' }))
          window.dispatchEvent(new CustomEvent('apt:refresh'))
          launchNext()   // free the slot for the next queued server
        },
      )
      socketsRef.current.push(ws)
    }

    for (let i = 0; i < Math.min(concurrency, queue.length); i++) launchNext()
  }

  const allSettled = started && Object.values(states).every(s => s === 'done' || s === 'error')

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Remediate {identifier} everywhere</h2>
          <button onClick={onClose} className="text-text-muted hover:text-red">✕</button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          {!started ? (
            <>
              <p className="text-xs text-text-muted">
                This will run a selective upgrade of exactly the fixing package(s) on each server
                below, using each server's own maintenance-window / override rules.
              </p>
              <div className="card p-3 max-h-56 overflow-y-auto space-y-1">
                {servers.map(s => (
                  <div key={s.server_id} className="font-mono text-xs text-text-muted">
                    <span className="text-text-primary">{s.name}</span> — {s.packages.join(', ')}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={start} className="btn-amber">
                  Remediate {servers.length} server{servers.length !== 1 ? 's' : ''}
                </button>
                <button onClick={onClose} className="btn-secondary">Cancel</button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {servers.map(s => (
                <div key={s.server_id} className="card p-2">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-text-primary">{s.name}</span>
                    <span className={
                      states[s.server_id] === 'done' ? 'text-green'
                      : states[s.server_id] === 'error' ? 'text-red'
                      : 'text-cyan animate-pulse'
                    }>
                      {states[s.server_id] === 'done' ? '✓ done'
                        : states[s.server_id] === 'error' ? '✗ error'
                        : '● running'}
                    </span>
                  </div>
                  {(lines[s.server_id] || []).length > 0 && (
                    <div className="mt-1 max-h-24 overflow-y-auto bg-bg border border-border rounded p-1.5 font-mono text-[10px] text-text-primary">
                      {(lines[s.server_id] || []).slice(-40).map((line, i) => (
                        <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {allSettled && <button onClick={onClose} className="btn-primary">Done</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Server → CVEs table (alt view) — pivot the same data by server
// ---------------------------------------------------------------------------

interface ServerRow {
  id: number
  name: string
  hostname: string
  cve_count: number
  worst_severity: CveSeverity
  severity_breakdown: Record<CveSeverity, number>
  cves: { cve_id: string; package: string; severity: CveSeverity }[]
}

function ServerTable({ rows }: { rows: CveInventoryRow[] }) {
  const serverRows = useMemo(() => buildServerPivot(rows), [rows])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  function toggle(id: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  if (serverRows.length === 0) {
    return (
      <div className="card p-8 text-center text-text-muted text-sm">
        No servers have pending CVEs in the current view.
      </div>
    )
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-border text-text-muted">
            <th className="text-left px-3 py-2 font-normal w-6"></th>
            <th className="text-left px-3 py-2 font-normal">Server</th>
            <th className="text-left px-3 py-2 font-normal">Hostname</th>
            <th className="text-right px-3 py-2 font-normal">CVEs</th>
            <th className="text-left px-3 py-2 font-normal">Worst</th>
            <th className="text-left px-3 py-2 font-normal">Breakdown</th>
            <th className="text-right px-3 py-2 font-normal w-32"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {serverRows.map(s => {
            const isOpen = expanded.has(s.id)
            return (
              <Fragment key={s.id}>
                <tr className="hover:bg-surface/50 cursor-pointer" onClick={() => toggle(s.id)}>
                  <td className="px-3 py-1.5 text-text-muted/70 select-none">{isOpen ? '▾' : '▸'}</td>
                  <td className="px-3 py-1.5 text-text-primary">{s.name}</td>
                  <td className="px-3 py-1.5 text-text-muted">{s.hostname}</td>
                  <td className="px-3 py-1.5 text-right text-text-primary">{s.cve_count}</td>
                  <td className="px-3 py-1.5"><SeverityBadge severity={s.worst_severity} /></td>
                  <td className="px-3 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {SEVERITIES.filter(sev => s.severity_breakdown[sev] > 0).map(sev => (
                        <span key={sev} className={`badge border text-[10px] font-mono ${SEV_BADGE[sev]}`}>
                          {sev[0].toUpperCase()}: {s.severity_breakdown[sev]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right" onClick={e => e.stopPropagation()}>
                    <Link to={`/servers/${s.id}?tab=packages`} className="text-cyan hover:underline">
                      Packages →
                    </Link>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-surface-2/40">
                    <td></td>
                    <td colSpan={6} className="px-3 py-3">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs font-mono">
                          <thead>
                            <tr className="text-text-muted/80 border-b border-border/40">
                              <th className="text-left px-2 py-1 font-normal">CVE</th>
                              <th className="text-left px-2 py-1 font-normal">Package</th>
                              <th className="text-left px-2 py-1 font-normal">Severity</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.cves.map(c => (
                              <tr key={`${c.cve_id}-${c.package}`} className="border-b border-border/20 last:border-0">
                                <td className="px-2 py-1">
                                  <a
                                    href={c.cve_id.startsWith('CVE-')
                                      ? `https://ubuntu.com/security/${c.cve_id}`
                                      : `https://ubuntu.com/security/notices/${c.cve_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan hover:underline"
                                  >
                                    {c.cve_id}
                                  </a>
                                </td>
                                <td className="px-2 py-1 text-text-primary">{c.package}</td>
                                <td className="px-2 py-1"><SeverityBadge severity={c.severity} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function buildServerPivot(rows: CveInventoryRow[]): ServerRow[] {
  const byServer = new Map<number, ServerRow>()
  for (const r of rows) {
    for (const s of r.affected_servers) {
      // For Server→CVEs, only count "pending" affected entries (a fixed entry doesn't impact the server today)
      if (s.status !== 'pending') continue
      let existing = byServer.get(s.id)
      if (!existing) {
        existing = {
          id: s.id,
          name: s.name,
          hostname: s.hostname,
          cve_count: 0,
          worst_severity: 'unknown',
          severity_breakdown: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
          cves: [],
        }
        byServer.set(s.id, existing)
      }
      existing.cve_count += 1
      existing.severity_breakdown[r.severity] += 1
      if (SEV_RANK[r.severity] > SEV_RANK[existing.worst_severity]) {
        existing.worst_severity = r.severity
      }
      existing.cves.push({ cve_id: r.cve_id, package: r.package, severity: r.severity })
    }
  }
  const out = [...byServer.values()]
  out.sort((a, b) =>
    SEV_RANK[b.worst_severity] - SEV_RANK[a.worst_severity]
    || b.cve_count - a.cve_count
    || a.name.localeCompare(b.name)
  )
  // sort each server's cve list by severity desc
  for (const s of out) {
    s.cves.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.cve_id.localeCompare(b.cve_id))
  }
  return out
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportCsv(view: ViewMode, rows: CveInventoryRow[]) {
  const date = new Date().toISOString().slice(0, 10)
  if (view === 'cve') {
    const csvRows: (string | number | null)[][] = []
    for (const r of rows) {
      for (const s of r.affected_servers) {
        csvRows.push([
          r.cve_id,
          r.usn_ids.join(';'),
          r.severity,
          r.package,
          r.fixed_version,
          r.first_seen_in_fleet ?? '',
          r.status,
          s.name,
          s.hostname,
          s.installed_version,
          s.status,
        ])
      }
      // CVEs with no affected servers (fixed-everywhere historical) — emit one row
      if (r.affected_servers.length === 0) {
        csvRows.push([
          r.cve_id,
          r.usn_ids.join(';'),
          r.severity,
          r.package,
          r.fixed_version,
          r.first_seen_in_fleet ?? '',
          r.status,
          '', '', '', '',
        ])
      }
    }
    downloadCsv(
      `cve-inventory-${date}.csv`,
      ['CVE', 'USNs', 'Severity', 'Package', 'Fixed Version', 'First Seen', 'CVE Status',
       'Server', 'Hostname', 'Installed Version', 'Server Status'],
      csvRows,
    )
  } else {
    const serverRows = buildServerPivot(rows)
    downloadCsv(
      `cve-by-server-${date}.csv`,
      ['Server', 'Hostname', 'CVE Count', 'Worst Severity',
       'Critical', 'High', 'Medium', 'Low', 'Unknown'],
      serverRows.map(s => [
        s.name, s.hostname, s.cve_count, s.worst_severity,
        s.severity_breakdown.critical, s.severity_breakdown.high,
        s.severity_breakdown.medium, s.severity_breakdown.low, s.severity_breakdown.unknown,
      ]),
    )
  }
}
