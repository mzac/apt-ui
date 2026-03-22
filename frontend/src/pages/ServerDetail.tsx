import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { servers as serversApi } from '@/api/client'
import type { Server, PackageInfo, UpdateHistory } from '@/types'
import { createUpgradeWebSocket, createSelectiveUpgradeWebSocket } from '@/api/client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import Convert from 'ansi-to-html'
import StatusDot from '@/components/StatusDot'

const ansiConvert = new Convert({ escapeXML: true })

const TABS = ['Packages', 'Terminal', 'History', 'Stats'] as const
type Tab = typeof TABS[number]

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>()
  const serverId = parseInt(id!)

  const [server, setServer] = useState<Server | null>(null)
  const [tab, setTab] = useState<Tab>('Packages')
  const [checking, setChecking] = useState(false)

  const load = useCallback(async () => {
    const list = await serversApi.list()
    const s = list.find(x => x.id === serverId) || null
    setServer(s)
  }, [serverId])

  useEffect(() => { load() }, [load])

  async function handleCheck() {
    setChecking(true)
    try { await serversApi.check(serverId); await load() }
    finally { setChecking(false) }
  }

  if (!server) return (
    <div className="flex items-center justify-center py-20 text-text-muted font-mono text-sm">Loading…</div>
  )

  const c = server.latest_check
  const statusVal = checking ? 'checking' : (!c ? 'unknown' : c.status === 'error' ? 'error' : c.packages_available > 0 ? 'updates_available' : 'up_to_date')

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-text-muted hover:text-text-primary text-sm">← Dashboard</Link>
          <StatusDot status={statusVal as any} size="md" />
          <div>
            <h1 className="font-mono text-lg text-text-primary">{server.name}</h1>
            <p className="text-text-muted text-xs font-mono">{server.hostname}:{server.ssh_port} · {server.username}</p>
          </div>
          {server.group_name && (
            <span
              className="badge text-xs"
              style={{ background: (server.group_color || '#3b82f6') + '22', color: server.group_color || '#3b82f6', border: `1px solid ${server.group_color || '#3b82f6'}44` }}
            >
              {server.group_name}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={handleCheck} disabled={checking} className="btn-secondary text-xs">
            {checking ? 'Checking…' : 'Check Now'}
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {c && (
        <div className="flex flex-wrap gap-3 text-xs font-mono text-text-muted">
          {server.os_info && <span className="text-text-primary">{server.os_info}</span>}
          {c.packages_available > 0 && (
            <span className="text-amber">{c.packages_available} updates ({c.security_packages} security)</span>
          )}
          {c.reboot_required && <span className="text-amber">↻ reboot required</span>}
          {c.held_packages > 0 && <span className="text-blue">{c.held_packages} held packages</span>}
          {c.checked_at && <span>checked {new Date(c.checked_at).toLocaleString()}</span>}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm transition-colors -mb-px border-b-2 ${
              tab === t ? 'border-green text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Packages' && <PackagesTab serverId={serverId} server={server} onRefresh={load} />}
      {tab === 'Terminal' && <TerminalTab serverId={serverId} server={server} onRefresh={load} />}
      {tab === 'History' && <HistoryTab serverId={serverId} />}
      {tab === 'Stats' && <StatsTab serverId={serverId} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Packages tab
// ---------------------------------------------------------------------------
function PackagesTab({ serverId, server, onRefresh }: { serverId: number; server: Server; onRefresh: () => void }) {
  const [packages, setPackages] = useState<PackageInfo[]>([])
  const [held, setHeld] = useState<string[]>([])
  const [sortCol, setSortCol] = useState<'name' | 'security'>('security')
  const [filterSec, setFilterSec] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [upgradeModal, setUpgradeModal] = useState(false)
  const [allowPhased, setAllowPhased] = useState(false)

  const loadPackages = useCallback(() => {
    serversApi.packages(serverId).then(data => {
      setPackages(data.packages)
      setHeld(data.held)
      setSelected(new Set())
    })
  }, [serverId])

  useEffect(() => { loadPackages() }, [loadPackages])

  const sorted = [...packages]
    .filter(p => !filterSec || p.is_security)
    .sort((a, b) => {
      if (sortCol === 'security') return (b.is_security ? 1 : 0) - (a.is_security ? 1 : 0)
      return a.name.localeCompare(b.name)
    })

  function toggleOne(name: string) {
    setSelected(s => {
      const n = new Set(s)
      n.has(name) ? n.delete(name) : n.add(name)
      return n
    })
  }

  function selectAll() { setSelected(new Set(sorted.map(p => p.name))) }
  function selectSecurity() { setSelected(new Set(sorted.filter(p => p.is_security).map(p => p.name))) }
  function clearSelection() { setSelected(new Set()) }

  const allChecked = sorted.length > 0 && sorted.every(p => selected.has(p.name))
  const someChecked = sorted.some(p => selected.has(p.name))

  return (
    <div className="space-y-4">
      {packages.length === 0 ? (
        <p className="text-text-muted text-sm py-8 text-center">No pending updates.</p>
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            <select className="input w-auto text-xs py-1" value={sortCol} onChange={e => setSortCol(e.target.value as any)}>
              <option value="security">Sort: Security first</option>
              <option value="name">Sort: Name</option>
            </select>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <input type="checkbox" checked={filterSec} onChange={e => setFilterSec(e.target.checked)} className="w-3 h-3 accent-red" />
              Security only
            </label>
            <div className="flex gap-1 ml-2">
              <button onClick={selectAll} className="btn-secondary text-xs py-0.5">All</button>
              <button onClick={selectSecurity} className="btn-secondary text-xs py-0.5">Security</button>
              <button onClick={clearSelection} className="btn-secondary text-xs py-0.5">Clear</button>
            </div>
            <span className="text-xs text-text-muted ml-auto">{sorted.length} packages</span>
            {someChecked && (
              <button
                onClick={() => setUpgradeModal(true)}
                className="btn-amber text-xs"
              >
                Upgrade Selected ({selected.size})
              </button>
            )}
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-text-muted uppercase text-xs">
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={e => e.target.checked ? selectAll() : clearSelection()}
                      className="w-3 h-3 accent-green"
                    />
                  </th>
                  <th className="text-left px-3 py-2">Package</th>
                  <th className="text-left px-3 py-2">Current</th>
                  <th className="text-left px-3 py-2">Available</th>
                  <th className="text-left px-3 py-2">Repo</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => (
                  <tr
                    key={p.name}
                    onClick={() => toggleOne(p.name)}
                    className={`border-b border-border/30 cursor-pointer transition-colors
                      ${selected.has(p.name) ? 'bg-green/5 border-green/20' : p.is_security ? 'bg-red/5' : ''}
                      hover:bg-surface-2/60`}
                  >
                    <td className="px-3 py-1.5" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(p.name)}
                        onChange={() => toggleOne(p.name)}
                        className="w-3 h-3 accent-green"
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono">
                      {p.is_security && <span className="text-red mr-1" title="Security update">🔒</span>}
                      {p.name}
                      {p.is_phased && <span className="ml-1 text-text-muted">[phased]</span>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-text-muted">{p.current_version}</td>
                    <td className="px-3 py-1.5 font-mono text-text-primary">→ {p.available_version}</td>
                    <td className="px-3 py-1.5 font-mono text-text-muted text-xs">{p.repository}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {held.length > 0 && (
        <div>
          <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">Held Packages ({held.length})</h3>
          <div className="card p-3 flex flex-wrap gap-1">
            {held.map(h => (
              <span key={h} className="badge bg-blue/10 text-blue border border-blue/30 text-xs font-mono">{h}</span>
            ))}
          </div>
        </div>
      )}

      {upgradeModal && (
        <SelectiveUpgradeModal
          serverId={serverId}
          packages={[...selected]}
          allowPhased={allowPhased}
          onClose={() => { setUpgradeModal(false); loadPackages(); onRefresh() }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Selective upgrade modal
// ---------------------------------------------------------------------------
function SelectiveUpgradeModal({ serverId, packages, allowPhased, onClose }: {
  serverId: number
  packages: string[]
  allowPhased: boolean
  onClose: () => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [done, setDone] = useState(false)
  const [phasedOpt, setPhasedOpt] = useState(allowPhased)
  const [started, setStarted] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => { wsRef.current?.close() }, [])
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
  }, [lines])

  function start() {
    setStarted(true)
    setLines([])
    const ws = createSelectiveUpgradeWebSocket(
      serverId,
      { packages, allow_phased: phasedOpt },
      (msg) => {
        if (msg.type === 'output') setLines(l => [...l, msg.data as string])
        else if (msg.type === 'status') setLines(l => [...l, `\x1b[36m[${msg.data}]\x1b[0m\n`])
        else if (msg.type === 'error') setLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
        else if (msg.type === 'complete') {
          const d = msg.data as { success: boolean; packages_upgraded: number }
          setLines(l => [...l, `\x1b[${d.success ? '32' : '31'}m\n[complete] ${d.success ? '✓' : '✗'} ${d.packages_upgraded} packages upgraded\x1b[0m\n`])
        }
      },
      () => setDone(true),
    )
    wsRef.current = ws
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Upgrade Selected Packages</h2>
          <button onClick={onClose} className="text-text-muted hover:text-red">✕</button>
        </div>

        {!started ? (
          <div className="p-4 space-y-4">
            <div className="card p-3 max-h-48 overflow-y-auto">
              {packages.map(p => (
                <div key={p} className="font-mono text-xs text-text-muted py-0.5">{p}</div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-text-muted">
              <input type="checkbox" checked={phasedOpt} onChange={e => setPhasedOpt(e.target.checked)} className="w-4 h-4 accent-green" />
              Allow phased updates
            </label>
            <div className="flex gap-2">
              <button onClick={start} className="btn-amber">Upgrade {packages.length} package{packages.length !== 1 ? 's' : ''}</button>
              <button onClick={onClose} className="btn-secondary">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col p-4 gap-3 min-h-0">
            <div
              ref={termRef}
              className="flex-1 overflow-y-auto bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary"
              style={{ minHeight: '200px' }}
            >
              {lines.map((line, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
              ))}
              {!done && <span className="text-cyan animate-pulse">▋</span>}
            </div>
            {done && <button onClick={onClose} className="btn-primary">Done</button>}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Terminal tab
// ---------------------------------------------------------------------------
function TerminalTab({ serverId, server, onRefresh }: { serverId: number; server: Server; onRefresh: () => void }) {
  const [action, setAction] = useState('upgrade')
  const [allowPhased, setAllowPhased] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => { wsRef.current?.close() }, [])
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
  }, [lines])

  function startUpgrade() {
    setLines([])
    setDone(false)
    setRunning(true)

    const ws = createUpgradeWebSocket(serverId, { action, allow_phased: allowPhased }, (msg) => {
      if (msg.type === 'output') {
        setLines(l => [...l, msg.data as string])
      } else if (msg.type === 'status') {
        setLines(l => [...l, `\x1b[36m[status] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'error') {
        setLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'complete') {
        const data = msg.data as { success: boolean; packages_upgraded: number }
        setLines(l => [...l, `\x1b[${data.success ? '32' : '31'}m\n[complete] ${data.success ? '✓ Upgrade successful' : '✗ Upgrade failed'} — ${data.packages_upgraded} packages\x1b[0m\n`])
      }
    }, () => {
      setRunning(false)
      setDone(true)
      onRefresh()
    })
    wsRef.current = ws
  }

  const hasUpdates = (server.latest_check?.packages_available ?? 0) > 0

  return (
    <div className="space-y-3">
      {!running && (
        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="label">Mode</label>
              <div className="flex gap-3">
                {['upgrade', 'dist-upgrade'].map(m => (
                  <label key={m} className="flex items-center gap-1.5 text-sm text-text-muted cursor-pointer">
                    <input type="radio" name="mode" value={m} checked={action === m} onChange={() => setAction(m)} className="accent-green" />
                    <span className="font-mono">{m}</span>
                  </label>
                ))}
              </div>
              {action === 'dist-upgrade' && (
                <p className="text-xs text-amber mt-1">⚠️ dist-upgrade may remove or install packages.</p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-text-muted">
              <input type="checkbox" checked={allowPhased} onChange={e => setAllowPhased(e.target.checked)} className="w-4 h-4 accent-green" />
              Allow phased updates
            </label>
            <button
              onClick={startUpgrade}
              disabled={!hasUpdates}
              className="btn-amber"
              title={!hasUpdates ? 'No updates available' : ''}
            >
              Run Upgrade
            </button>
          </div>
        </div>
      )}

      <div
        ref={termRef}
        className="bg-bg border border-border rounded p-3 font-mono text-xs text-text-primary overflow-y-auto"
        style={{ minHeight: '300px', maxHeight: '60vh' }}
      >
        {lines.length === 0 && !running && (
          <span className="text-text-muted">Terminal output will appear here when an upgrade runs.</span>
        )}
        {lines.map((line, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
        ))}
        {running && <span className="text-cyan animate-pulse">▋</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------
function HistoryTab({ serverId }: { serverId: number }) {
  const [items, setItems] = useState<UpdateHistory[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    serversApi.history(serverId, page).then(data => {
      setItems(data.items)
      setTotal(data.total)
    })
  }, [serverId, page])

  if (items.length === 0) return <p className="text-text-muted text-sm py-8 text-center">No upgrade history.</p>

  return (
    <div className="space-y-2">
      {items.map(h => (
        <div key={h.id} className="card overflow-hidden">
          <button
            className="w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-surface-2/50 transition-colors"
            onClick={() => setExpanded(expanded === h.id ? null : h.id)}
          >
            <div className="flex items-center gap-3 text-sm">
              <span className={h.status === 'success' ? 'text-green' : h.status === 'error' ? 'text-red' : 'text-cyan'}>
                {h.status === 'success' ? '✓' : h.status === 'error' ? '✗' : '⚙'}
              </span>
              <span className="font-mono">{h.action}</span>
              <span className="text-text-muted">{new Date(h.started_at).toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-text-muted">
              {h.packages_upgraded && <span>{h.packages_upgraded.length} pkgs</span>}
              {h.initiated_by && <span className="font-mono">{h.initiated_by}</span>}
              {h.phased_updates && <span className="badge bg-blue/10 text-blue border border-blue/30">phased</span>}
              <span>{expanded === h.id ? '▲' : '▼'}</span>
            </div>
          </button>
          {expanded === h.id && h.log_output && (
            <div className="border-t border-border bg-bg px-3 py-2 font-mono text-xs text-text-primary overflow-x-auto max-h-64 overflow-y-auto">
              <pre className="whitespace-pre-wrap">{h.log_output}</pre>
            </div>
          )}
        </div>
      ))}

      {total > 20 && (
        <div className="flex gap-2 justify-center text-sm">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="btn-secondary">Prev</button>
          <span className="text-text-muted self-center">{page} / {Math.ceil(total / 20)}</span>
          <button disabled={page >= Math.ceil(total / 20)} onClick={() => setPage(p => p + 1)} className="btn-secondary">Next</button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stats tab
// ---------------------------------------------------------------------------
function StatsTab({ serverId }: { serverId: number }) {
  const [data, setData] = useState<{ date: string; packages: number; security: number }[]>([])

  useEffect(() => {
    // Build trend from history checks — fetch multiple pages
    serversApi.history(serverId, 1).then(result => {
      const points = result.items
        .filter(h => h.status === 'success')
        .slice(0, 30)
        .reverse()
        .map(h => ({
          date: new Date(h.started_at).toLocaleDateString(),
          packages: h.packages_upgraded?.length ?? 0,
          security: 0,
        }))
      setData(points)
    })
  }, [serverId])

  if (data.length === 0) return <p className="text-text-muted text-sm py-8 text-center">No stats available yet.</p>

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="text-xs text-text-muted uppercase tracking-wide mb-4">Packages upgraded per run (last 30)</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 11 }} />
            <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: '#1a1d27', border: '1px solid #2e3347', borderRadius: '4px', fontSize: '12px' }}
              labelStyle={{ color: '#e5e7eb' }}
            />
            <Line type="monotone" dataKey="packages" stroke="#22c55e" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
