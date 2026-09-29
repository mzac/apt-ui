import { useState, useRef, useEffect } from 'react'
import type { Server } from '@/types'
import { createAutoremoveAllWebSocket, stats as statsApi } from '@/api/client'
import { useJobStore } from '@/hooks/useJobStore'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { confirmDialog } from '@/hooks/useConfirm'
import { relativeTime } from '@/utils/datetime'
import Convert from 'ansi-to-html'

const ansiConvert = new Convert({ escapeXML: true })

interface Props {
  servers: Server[]
  onClose: () => void
}

interface ServerProgress {
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled'
  lines: string[]
}

// A server keeps streaming output after its 'complete' message (hook output, the
// trailing summary line), so a late 'output'/'status' must never downgrade a
// terminal result back to "running" — that flipped finished ✓ chips to ⚙️.
const TERMINAL: ServerProgress['status'][] = ['done', 'error', 'skipped', 'cancelled']
const liveStatus = (prev?: ServerProgress): ServerProgress['status'] =>
  prev && TERMINAL.includes(prev.status) ? prev.status : 'running'

export default function AutoremoveAllModal({ servers, onClose }: Props) {
  const [started, setStarted] = useState(false)
  // Snapshot of targets at start(); running view renders from this so the dashboard
  // poll mutating the live `servers` prop can't make rows vanish mid-operation.
  const [runServers, setRunServers] = useState<Server[]>([])
  const [progress, setProgress] = useState<Record<number, ServerProgress>>({})
  const [done, setDone] = useState(false)
  const [filterServer, setFilterServer] = useState<number | null>(null)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [runCancelled, setRunCancelled] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const { addJob, updateJob } = useJobStore()
  const pendingRef = useRef(0)

  const totalPackages = servers.reduce((sum, s) => sum + (s.latest_check?.autoremove_count ?? 0), 0)

  // Package names per server, from each server's last check (one aggregate call,
  // same as the Pending Updates modal) — shown before start so it's clear what goes.
  const [pkgMap, setPkgMap] = useState<Record<number, { packages: string[]; checked_at: string | null }> | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    statsApi.pendingAutoremove()
      .then(res => {
        if (cancelled) return
        const map: Record<number, { packages: string[]; checked_at: string | null }> = {}
        for (const row of res.servers) map[row.id] = { packages: row.packages, checked_at: row.checked_at }
        setPkgMap(map)
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [])

  const q = filter.trim().toLowerCase()

  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

  // Keep the terminal pinned to the newest line as output streams in.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [progress])

  // Escape closes the modal before start or once done (not mid-run).
  useEscapeKey(handleClose, !started || done)

  function start() {
    const snapshot = servers
    setStarted(true)
    setRunServers(snapshot)
    pendingRef.current = snapshot.length
    const initial: Record<number, ServerProgress> = {}
    snapshot.forEach(s => { initial[s.id] = { status: 'pending', lines: [] } })
    setProgress(initial)

    addJob({
      id: 'autoremove-all',
      type: 'upgrade-all',
      label: `Autoremove All (${snapshot.length} servers)`,
      status: 'running',
      link: '/',
      startedAt: Date.now(),
    })

    const ws = createAutoremoveAllWebSocket((msg) => {
      const sid = msg.server_id as number

      // Fleet-level terminal message — sent once, right before the socket closes,
      // only when a stop request was actually honoured.
      if (msg.type === 'complete' && !sid) {
        const data = msg.data as { cancelled?: boolean }
        if (data?.cancelled) setRunCancelled(true)
        return
      }
      if (!sid) return

      if (msg.type === 'output') {
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status: liveStatus(p[sid]), lines: [...(p[sid]?.lines || []), msg.data as string] },
        }))
      } else if (msg.type === 'status') {
        setProgress(p => ({ ...p, [sid]: { ...p[sid], status: liveStatus(p[sid]) } }))
      } else if (msg.type === 'complete') {
        const data = msg.data as { success: boolean }
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status: data.success ? 'done' : 'error' },
        }))
        pendingRef.current -= 1
        if (pendingRef.current <= 0) {
          updateJob('autoremove-all', { status: 'complete', completedAt: Date.now() })
        }
      } else if (msg.type === 'skipped') {
        // Maintenance-window / backend-dropped target, or a not-yet-started server
        // dropped by a "Stop after current" request — terminal, but NOT a failure.
        // The 'cancelled' flag distinguishes the latter so it renders distinctly.
        const status: ServerProgress['status'] = msg.cancelled ? 'cancelled' : 'skipped'
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status, lines: [...(p[sid]?.lines || []), msg.data as string] },
        }))
        pendingRef.current -= 1
        if (pendingRef.current <= 0) {
          updateJob('autoremove-all', { status: 'complete', completedAt: Date.now() })
        }
      } else if (msg.type === 'error') {
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status: 'error', lines: [...(p[sid]?.lines || []), msg.data as string] },
        }))
        pendingRef.current -= 1
        if (pendingRef.current <= 0) {
          updateJob('autoremove-all', { status: 'error', completedAt: Date.now() })
        }
      }
    }, (ev) => {
      setDone(true)
      if (pendingRef.current > 0) {
        pendingRef.current = 0
        updateJob('autoremove-all', { status: 'error', completedAt: Date.now() })
        const note = ev && !ev.wasClean
          ? '✗ Connection closed before this server finished.'
          : '✗ Stream ended without a completion message.'
        setProgress(p => {
          const next: Record<number, ServerProgress> = {}
          for (const [k, v] of Object.entries(p)) {
            next[+k] = (v.status === 'pending' || v.status === 'running')
              ? { ...v, status: 'error', lines: [...v.lines, note] }
              : v
          }
          return next
        })
      }
    }, { server_ids: servers.map(s => s.id) })

    wsRef.current = ws
  }

  function handleClose() {
    window.dispatchEvent(new CustomEvent('apt:refresh'))
    onClose()
  }

  // "Stop after current" — asks for confirmation, then sends a cancel frame over
  // the already-open socket. cancelRequested guards against double-submit; the
  // button itself is also hidden once the run finishes.
  async function handleStop() {
    if (cancelRequested) return
    const ok = await confirmDialog({
      message: 'Stop this autoremove run? Servers already running will finish; servers not yet started will be skipped.',
      confirmLabel: 'Stop',
      danger: true,
    })
    if (!ok) return
    setCancelRequested(true)
    try {
      wsRef.current?.send(JSON.stringify({ action: 'cancel' }))
    } catch {
      // socket already closed — nothing to do, the run has already ended
    }
  }

  const statusIcon = (s: ServerProgress['status']) =>
    ({ pending: '⏳', running: '⚙️', done: '✓', error: '✗', skipped: '⏭️', cancelled: '⏹️' }[s])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Autoremove All Servers</h2>
          <div className="flex items-center gap-2">
            {started && !done && (
              <button
                onClick={handleStop}
                disabled={cancelRequested}
                className="btn-secondary text-xs text-red disabled:opacity-50 disabled:cursor-not-allowed"
                title="Stop after the currently running server(s) finish"
              >
                {cancelRequested ? 'Stopping…' : 'Stop after current'}
              </button>
            )}
            {(!started || done) && (
              <button onClick={handleClose} className="text-text-muted hover:text-red">✕</button>
            )}
          </div>
        </div>

        {!started ? (
          <div className="p-4 space-y-4">
            <p className="text-sm text-text-muted">
              Run <span className="font-mono text-text-primary">apt-get autoremove</span> on{' '}
              <span className="text-amber font-mono">{servers.length} server{servers.length !== 1 ? 's' : ''}</span>{' '}
              to remove {totalPackages} orphaned package{totalPackages !== 1 ? 's' : ''}.
            </p>

            <input
              type="text"
              placeholder="Filter packages…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="input text-xs px-2 py-1 w-48"
            />

            <div className="overflow-y-auto max-h-[45vh] border border-border rounded divide-y divide-border/40">
              {loadError && (
                <div className="px-3 py-4 text-center text-xs text-red font-mono">Failed to load package lists.</div>
              )}
              {servers.map(s => {
                const entry = pkgMap?.[s.id]
                const loading = pkgMap === null && !loadError
                const pkgs = (entry?.packages ?? []).filter(p => !q || p.toLowerCase().includes(q))
                // When filtering, hide servers with no matching packages.
                if (q && !loading && pkgs.length === 0) return null
                return (
                  <div key={s.id} className="px-3 py-2 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs font-mono">
                      <span className="text-text-primary font-medium">{s.name}</span>
                      <span className="text-text-muted">{s.hostname}</span>
                      <span className="text-amber ml-auto shrink-0">{s.latest_check?.autoremove_count} removable</span>
                    </div>
                    {loading && (
                      <div className="text-xs text-text-muted font-mono animate-pulse">Loading packages…</div>
                    )}
                    {!loading && entry && entry.packages.length === 0 && (
                      <div className="text-xs text-text-muted font-mono">No package details available — re-check this server to list them.</div>
                    )}
                    {!loading && pkgs.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {pkgs.map(p => (
                          <span key={p} className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-2/60 border border-border text-text-primary">
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                    {!loading && entry?.checked_at && (
                      <div className="text-[11px] text-text-muted font-mono">as of last check, {relativeTime(entry.checked_at)}</div>
                    )}
                  </div>
                )
              })}
            </div>

            <p className="text-xs text-text-muted">
              The list comes from each server's last check. <span className="font-mono">apt-get autoremove</span> removes
              whatever is orphaned at the time it runs, so it can differ if packages changed since.
            </p>

            <div className="flex gap-2">
              <button onClick={start} className="btn-amber">Start Autoremove</button>
              <button onClick={handleClose} className="btn-secondary">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col p-4 gap-3">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFilterServer(null)}
                className={`px-2 py-1 rounded text-xs font-mono border transition-colors ${
                  filterServer === null
                    ? 'bg-surface border-text-muted text-text-primary'
                    : 'border-border text-text-muted hover:border-text-muted'
                }`}
              >
                All
              </button>
              {runServers.map(s => {
                const p = progress[s.id]
                const active = filterServer === s.id
                const borderColor =
                  p?.status === 'done' ? '#22c55e' :
                  p?.status === 'error' ? '#ef4444' :
                  p?.status === 'running' ? '#06b6d4' :
                  p?.status === 'cancelled' ? '#6b7280' : '#374151'
                return (
                  <button
                    key={s.id}
                    onClick={() => setFilterServer(active ? null : s.id)}
                    className={`px-2 py-1 rounded text-xs font-mono border transition-colors flex items-center gap-1.5 ${
                      active ? 'bg-surface text-text-primary' : 'text-text-muted hover:text-text-primary'
                    }`}
                    style={{ borderColor: active ? borderColor : undefined }}
                  >
                    <span>{statusIcon(p?.status || 'pending')}</span>
                    <span className="truncate max-w-[100px]">{s.name}</span>
                  </button>
                )
              })}
            </div>

            <div
              ref={termRef}
              className="flex-1 overflow-y-auto bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary min-h-0"
              style={{ maxHeight: '40vh' }}
            >
              {runServers.flatMap(s => {
                if (filterServer !== null && filterServer !== s.id) return []
                return (progress[s.id]?.lines || []).map((line, i) => (
                  <div key={`${s.id}-${i}`}>
                    {filterServer === null && <span className="text-text-muted">[{s.name}] </span>}
                    <span dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
                  </div>
                ))
              })}
            </div>

            {done && (
              <div className="space-y-2">
                {runCancelled && (
                  <p className="text-xs text-text-muted">⏹️ Run stopped — servers not yet started were skipped.</p>
                )}
                <button onClick={handleClose} className="btn-primary">Done</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
