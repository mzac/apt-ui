import { useState, useRef, useEffect } from 'react'
import type { Server } from '@/types'
import { createAutoremoveAllWebSocket } from '@/api/client'
import { useJobStore } from '@/hooks/useJobStore'
import Convert from 'ansi-to-html'

const ansiConvert = new Convert({ escapeXML: true })

interface Props {
  servers: Server[]
  onClose: () => void
}

interface ServerProgress {
  status: 'pending' | 'running' | 'done' | 'error'
  lines: string[]
}

export default function AutoremoveAllModal({ servers, onClose }: Props) {
  const [started, setStarted] = useState(false)
  // Snapshot of targets at start(); running view renders from this so the dashboard
  // poll mutating the live `servers` prop can't make rows vanish mid-operation.
  const [runServers, setRunServers] = useState<Server[]>([])
  const [progress, setProgress] = useState<Record<number, ServerProgress>>({})
  const [done, setDone] = useState(false)
  const [filterServer, setFilterServer] = useState<number | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const { addJob, updateJob } = useJobStore()
  const pendingRef = useRef(0)

  const totalPackages = servers.reduce((sum, s) => sum + (s.latest_check?.autoremove_count ?? 0), 0)

  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

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
      if (!sid) return

      if (msg.type === 'output') {
        setProgress(p => ({
          ...p,
          [sid]: { ...p[sid], status: 'running', lines: [...(p[sid]?.lines || []), msg.data as string] },
        }))
      } else if (msg.type === 'status') {
        setProgress(p => ({ ...p, [sid]: { ...p[sid], status: 'running' } }))
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

  const statusIcon = (s: ServerProgress['status']) =>
    ({ pending: '⏳', running: '⚙️', done: '✓', error: '✗' }[s])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Autoremove All Servers</h2>
          {(!started || done) && (
            <button onClick={handleClose} className="text-text-muted hover:text-red">✕</button>
          )}
        </div>

        {!started ? (
          <div className="p-4 space-y-4">
            <p className="text-sm text-text-muted">
              Run <span className="font-mono text-text-primary">apt-get autoremove</span> on{' '}
              <span className="text-amber font-mono">{servers.length} server{servers.length !== 1 ? 's' : ''}</span>{' '}
              to remove {totalPackages} orphaned package{totalPackages !== 1 ? 's' : ''}.
            </p>

            <div className="space-y-1">
              {servers.map(s => (
                <div key={s.id} className="flex items-center justify-between text-xs font-mono text-text-muted">
                  <span>{s.name} ({s.hostname})</span>
                  <span className="text-amber">{s.latest_check?.autoremove_count} removable</span>
                </div>
              ))}
            </div>

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
                  </button>
                )
              })}
            </div>

            <div
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
              <button onClick={handleClose} className="btn-primary">Done</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
