import { useState, useRef, useEffect } from 'react'
import type { Server } from '@/types'
import { createUpgradeWebSocket } from '@/api/client'
import Convert from 'ansi-to-html'

const ansiConvert = new Convert({ escapeXML: true })

interface Props {
  servers: Server[]
  onClose: () => void
}

interface ServerProgress {
  status: 'pending' | 'running' | 'done' | 'error'
  lines: string[]
  packagesUpgraded?: number
}

export default function UpgradeAllModal({ servers, onClose }: Props) {
  const [action, setAction] = useState('upgrade')
  const [allowPhased, setAllowPhased] = useState(false)
  const [started, setStarted] = useState(false)
  const [progress, setProgress] = useState<Record<number, ServerProgress>>({})
  const [done, setDone] = useState(false)
  const [filterServer, setFilterServer] = useState<number | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  const totalPackages = servers.reduce((sum, s) => sum + (s.latest_check?.packages_available ?? 0), 0)

  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

  function start() {
    setStarted(true)
    const initial: Record<number, ServerProgress> = {}
    servers.forEach(s => { initial[s.id] = { status: 'pending', lines: [] } })
    setProgress(initial)

    const ws = createUpgradeWebSocket('all', { action, allow_phased: allowPhased }, (msg) => {
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
      } else if (msg.type === 'error') {
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status: 'error', lines: [...(p[sid]?.lines || []), msg.data as string] },
        }))
      }
    }, () => setDone(true))

    wsRef.current = ws
  }

  const statusIcon = (s: ServerProgress['status']) =>
    ({ pending: '⏳', running: '⚙️', done: '✓', error: '✗' }[s])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Upgrade All Servers</h2>
          <button onClick={onClose} className="text-text-muted hover:text-red">✕</button>
        </div>

        {!started ? (
          <div className="p-4 space-y-4">
            <p className="text-sm text-text-muted">
              This will upgrade <span className="text-amber font-mono">{servers.length} servers</span> ({totalPackages} total packages).
            </p>

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
            </div>

            <div className="flex items-center gap-2">
              <input type="checkbox" id="phased-all" checked={allowPhased} onChange={e => setAllowPhased(e.target.checked)} className="w-4 h-4 accent-green" />
              <label htmlFor="phased-all" className="text-sm text-text-muted">Allow phased updates</label>
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
              <button onClick={onClose} className="btn-secondary">Cancel</button>
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
              <button onClick={onClose} className="btn-primary">Done</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
