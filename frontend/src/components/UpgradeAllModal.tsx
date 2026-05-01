import { useState, useRef, useEffect } from 'react'
import type { Server } from '@/types'
import { createUpgradeWebSocket } from '@/api/client'
import { useJobStore } from '@/hooks/useJobStore'
import Convert from 'ansi-to-html'

const ansiConvert = new Convert({ escapeXML: true })

interface Props {
  servers: Server[]
  onClose: () => void
  onMinimize?: () => void
}

interface ServerProgress {
  status: 'pending' | 'running' | 'done' | 'error'
  lines: string[]
  packagesUpgraded?: number
}

export default function UpgradeAllModal({ servers, onClose, onMinimize }: Props) {
  // Auto-default to dist-upgrade when any server has new dependency packages
  // (e.g. new kernel) or kept-back packages — plain `apt-get upgrade` would skip them.
  const needsDistUpgrade = servers.some(s =>
    (s.latest_check?.kept_back_count ?? 0) > 0 ||
    (s.latest_check?.new_packages_count ?? 0) > 0
  )
  const serversNeedingDist = servers.filter(s =>
    (s.latest_check?.kept_back_count ?? 0) > 0 ||
    (s.latest_check?.new_packages_count ?? 0) > 0
  )
  const [action, setAction] = useState(needsDistUpgrade ? 'dist-upgrade' : 'upgrade')
  const [allowPhased, setAllowPhased] = useState(false)
  const [rebootIfRequired, setRebootIfRequired] = useState(false)
  const [started, setStarted] = useState(false)
  const [progress, setProgress] = useState<Record<number, ServerProgress>>({})
  const [done, setDone] = useState(false)
  const [filterServer, setFilterServer] = useState<number | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const { addJob, updateJob } = useJobStore()
  const pendingRef = useRef(0)

  const totalPackages = servers.reduce((sum, s) => sum + (s.latest_check?.packages_available ?? 0), 0)

  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

  function start() {
    setStarted(true)
    pendingRef.current = servers.length
    const initial: Record<number, ServerProgress> = {}
    servers.forEach(s => { initial[s.id] = { status: 'pending', lines: [] } })
    setProgress(initial)

    addJob({
      id: 'upgrade-all',
      type: 'upgrade-all',
      label: `Upgrade All (${servers.length} servers)`,
      status: 'running',
      link: '/',
      action: 'restore-upgrade-all',
      startedAt: Date.now(),
    })

    const ws = createUpgradeWebSocket('all', { action, allow_phased: allowPhased, reboot_if_required: rebootIfRequired }, (msg) => {
      const sid = msg.server_id as number
      if (!sid) return

      if (msg.type === 'output') {
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status: 'running', lines: [...(p[sid]?.lines || []), msg.data as string] },
        }))
      } else if (msg.type === 'status') {
        setProgress(p => ({ ...p, [sid]: { ...p[sid], status: 'running' } }))
      } else if (msg.type === 'complete') {
        const data = msg.data as { success: boolean; packages_upgraded: number }
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status: data.success ? 'done' : 'error', packagesUpgraded: data.packages_upgraded },
        }))
        pendingRef.current -= 1
        if (pendingRef.current <= 0) {
          updateJob('upgrade-all', { status: 'complete', completedAt: Date.now(), action: undefined })
        }
      } else if (msg.type === 'error') {
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status: 'error', lines: [...(p[sid]?.lines || []), msg.data as string] },
        }))
        pendingRef.current -= 1
        if (pendingRef.current <= 0) {
          updateJob('upgrade-all', { status: 'error', completedAt: Date.now(), action: undefined })
        }
      }
    }, () => setDone(true))

    wsRef.current = ws
  }

  function handleClose() {
    window.dispatchEvent(new CustomEvent('apt:refresh'))
    onClose()
  }

  const statusIcon = (s: ServerProgress['status']) =>
    ({ pending: '⏳', running: '⚙️', done: '✓', error: '✗' }[s])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Upgrade All Servers</h2>
          <div className="flex items-center gap-2">
            {started && !done && onMinimize && (
              <button
                onClick={onMinimize}
                className="text-text-muted hover:text-text-primary text-lg leading-none"
                title="Minimize"
              >
                ─
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
              This will upgrade <span className="text-amber font-mono">{servers.length} servers</span> ({totalPackages} total packages).
            </p>

            {needsDistUpgrade && (
              <div className="rounded border border-amber/30 bg-amber/5 px-3 py-2 text-xs space-y-1">
                <p className="font-medium text-amber">
                  ⚠ {serversNeedingDist.length} server{serversNeedingDist.length > 1 ? 's' : ''} require dist-upgrade
                </p>
                <p className="text-text-muted">
                  These servers have packages that would be skipped by plain <span className="font-mono">apt-get upgrade</span> —
                  typically new kernel versions pulled in as dependencies, or packages held back due to new deps.
                  The mode below has been pre-selected to <span className="font-mono text-amber">dist-upgrade</span> so they install correctly.
                </p>
                <details className="text-text-muted/70">
                  <summary className="cursor-pointer hover:text-text-muted">Affected servers</summary>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    {serversNeedingDist.map(s => {
                      const kb = s.latest_check?.kept_back_count ?? 0
                      const np = s.latest_check?.new_packages_count ?? 0
                      return (
                        <li key={s.id}>
                          {s.name}{' '}
                          {kb > 0 && <span className="text-amber">{kb} kept back</span>}
                          {kb > 0 && np > 0 && <span>, </span>}
                          {np > 0 && <span className="text-cyan">{np} new</span>}
                        </li>
                      )
                    })}
                  </ul>
                </details>
              </div>
            )}

            <div className="space-y-2">
              <label className="label">Upgrade mode</label>
              <div className="flex gap-3">
                {['upgrade', 'dist-upgrade'].map(m => (
                  <label key={m} className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
                    <input type="radio" name="action" value={m} checked={action === m} onChange={() => setAction(m)} className="accent-green" />
                    <span className="font-mono">{m}</span>
                  </label>
                ))}
              </div>
              {action === 'dist-upgrade' && (
                <p className="text-xs text-amber">⚠️ dist-upgrade may remove or install packages to resolve dependencies.</p>
              )}
              {action === 'upgrade' && needsDistUpgrade && (
                <p className="text-xs text-red">⚠️ Switching to plain upgrade will skip kernel/kept-back packages on the listed servers.</p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <input type="checkbox" id="phased-all" checked={allowPhased} onChange={e => setAllowPhased(e.target.checked)} className="w-4 h-4 accent-green" />
              <label htmlFor="phased-all" className="text-sm text-text-muted">Allow phased updates</label>
            </div>

            <div className="flex items-center gap-2">
              <input type="checkbox" id="reboot-all" checked={rebootIfRequired} onChange={e => setRebootIfRequired(e.target.checked)} className="w-4 h-4 accent-amber" />
              <label htmlFor="reboot-all" className="text-sm text-text-muted" title="Auto-reboot any server with /var/run/reboot-required after a successful upgrade">
                Reboot servers if required after upgrade
              </label>
            </div>

            <div className="space-y-1">
              {servers.map(s => (
                <div key={s.id} className="flex items-center justify-between text-xs font-mono text-text-muted">
                  <span>{s.name} ({s.hostname})</span>
                  <span className="text-amber">{s.latest_check?.packages_available} pkgs</span>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button onClick={start} className="btn-amber">Start Upgrade</button>
              <button onClick={handleClose} className="btn-secondary">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col p-4 gap-3">
            {/* Server status chips — click to filter terminal output */}
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
              {servers.map(s => {
                const p = progress[s.id]
                const active = filterServer === s.id
                const borderColor =
                  p?.status === 'done' ? '#22c55e' :
                  p?.status === 'error' ? '#ef4444' :
                  p?.status === 'running' ? '#06b6d4' : '#374151'
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
                    {p?.packagesUpgraded != null && <span className="text-text-muted">{p.packagesUpgraded}↑</span>}
                  </button>
                )
              })}
            </div>

            {/* Terminal output — filtered by selected server or all */}
            <div
              ref={termRef}
              className="flex-1 overflow-y-auto bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary min-h-0"
              style={{ maxHeight: '40vh' }}
            >
              {servers.flatMap(s => {
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
              <button onClick={handleClose} className="btn-primary">Done</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
