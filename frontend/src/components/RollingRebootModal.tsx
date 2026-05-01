import { useState, useRef, useEffect, useMemo } from 'react'
import type { Server, ScheduleConfig } from '@/types'
import { createRebootAllWebSocket, scheduler as schedulerApi } from '@/api/client'
import { useJobStore } from '@/hooks/useJobStore'

interface Props {
  servers: Server[]
  onClose: () => void
}

type RebootPhase = 'pending' | 'rebooting' | 'waiting' | 'back' | 'failed' | 'error'

interface ServerProgress {
  phase: RebootPhase
  message?: string
}

// Group servers by their first ring:* tag (or "ring:default") — mirrors the
// backend grouping used by /api/ws/reboot-all so the confirm step shows the
// same plan that will execute.
function groupByRing(servers: Server[]): Record<string, Server[]> {
  const rings: Record<string, Server[]> = {}
  for (const s of servers) {
    const ringTags = (s.tags ?? [])
      .map(t => t.name)
      .filter(n => n.startsWith('ring:'))
      .sort()
    const ring = ringTags[0] ?? 'ring:default'
    if (!rings[ring]) rings[ring] = []
    rings[ring].push(s)
  }
  return rings
}

export default function RollingRebootModal({ servers, onClose }: Props) {
  const [started, setStarted] = useState(false)
  const [progress, setProgress] = useState<Record<number, ServerProgress>>({})
  const [done, setDone] = useState(false)
  const [filterServer, setFilterServer] = useState<number | null>(null)
  const [activeRing, setActiveRing] = useState<string | null>(null)
  const [activeBatch, setActiveBatch] = useState<number[] | null>(null)
  const [waitingSeconds, setWaitingSeconds] = useState(0)
  const [aborted, setAborted] = useState(false)
  const [abortReason, setAbortReason] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [cfg, setCfg] = useState<ScheduleConfig | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const { addJob, updateJob } = useJobStore()
  const completedRef = useRef(0)

  useEffect(() => {
    schedulerApi.status().then(setCfg).catch(() => {})
    return () => { wsRef.current?.close() }
  }, [])

  const rings = useMemo(() => groupByRing(servers), [servers])
  const ringNames = useMemo(() => Object.keys(rings).sort(), [rings])

  const batchSize = cfg?.reboot_batch_size ?? cfg?.upgrade_concurrency ?? 3
  const waitMinutes = cfg?.reboot_batch_wait_minutes ?? 5
  const timeoutMinutes = cfg?.reboot_timeout_minutes ?? 10

  function start() {
    setStarted(true)
    completedRef.current = 0
    const initial: Record<number, ServerProgress> = {}
    servers.forEach(s => { initial[s.id] = { phase: 'pending' } })
    setProgress(initial)

    addJob({
      id: 'reboot-all',
      type: 'upgrade-all',
      label: `Rolling Reboot (${servers.length} servers)`,
      status: 'running',
      link: '/',
      startedAt: Date.now(),
    })

    const ws = createRebootAllWebSocket((msg) => {
      const t = msg.type as string
      const sid = msg.server_id as number | undefined

      if (t === 'plan') {
        // initial plan summary — log it
        setLogs(l => [...l, `[plan] rings: ${ringNames.join(' → ')}, batch=${batchSize}, wait=${waitMinutes}m`])
        return
      }
      if (t === 'ring_start') {
        const data = msg.data as { name: string; server_count: number; ring_index: number; ring_total: number }
        setActiveRing(data.name)
        setLogs(l => [...l, `[ring] starting ${data.name} (${data.server_count} servers, ${data.ring_index + 1}/${data.ring_total})`])
        return
      }
      if (t === 'batch_start') {
        const data = msg.data as { ring: string; size: number; server_ids: number[] }
        setActiveBatch(data.server_ids)
        setLogs(l => [...l, `[batch] ${data.ring} — rebooting ${data.size} server(s)`])
        return
      }
      if (t === 'batch_wait') {
        const data = msg.data as { seconds: number }
        setWaitingSeconds(data.seconds)
        setLogs(l => [...l, `[wait] sleeping ${Math.round(data.seconds / 60)}m before next batch`])
        // Tick down the wait counter for the UI
        const start = Date.now()
        const tickId = setInterval(() => {
          const remaining = Math.max(0, data.seconds - Math.floor((Date.now() - start) / 1000))
          setWaitingSeconds(remaining)
          if (remaining === 0) clearInterval(tickId)
        }, 1000)
        return
      }
      if (t === 'abort') {
        const data = msg.data as { ring: string; reason: string }
        setAborted(true)
        setAbortReason(data.reason)
        setLogs(l => [...l, `[abort] ring ${data.ring}: ${data.reason}`])
        updateJob('reboot-all', { status: 'error', completedAt: Date.now() })
        return
      }
      if (t === 'complete' && !sid) {
        const data = msg.data as { success: boolean; aborted?: boolean }
        if (!data.aborted) {
          updateJob('reboot-all', { status: data.success ? 'complete' : 'error', completedAt: Date.now() })
        }
        return
      }
      if (!sid) return

      if (t === 'status') {
        const phase = (msg.phase as RebootPhase) ?? 'rebooting'
        setProgress(p => ({ ...p, [sid]: { phase } }))
      } else if (t === 'complete') {
        const data = msg.data as { success: boolean; phase?: RebootPhase }
        const finalPhase: RebootPhase = data.phase ?? (data.success ? 'back' : 'failed')
        setProgress(p => ({ ...p, [sid]: { phase: finalPhase } }))
        completedRef.current += 1
      } else if (t === 'error') {
        setProgress(p => ({ ...p, [sid]: { phase: 'error', message: msg.data as string } }))
        completedRef.current += 1
      }
    }, () => setDone(true))

    wsRef.current = ws
  }

  function handleClose() {
    window.dispatchEvent(new CustomEvent('apt:refresh'))
    onClose()
  }

  const phaseColor = (phase: RebootPhase): string => {
    switch (phase) {
      case 'back': return '#22c55e'        // green
      case 'rebooting':
      case 'waiting': return '#06b6d4'     // cyan
      case 'failed':
      case 'error': return '#ef4444'       // red
      case 'pending':
      default: return '#374151'            // gray
    }
  }

  const phaseIcon = (phase: RebootPhase): string =>
    ({ pending: '⏳', rebooting: '↻', waiting: '⌛', back: '✓', failed: '✗', error: '✗' }[phase])

  const phaseLabel = (phase: RebootPhase): string =>
    ({ pending: 'pending', rebooting: 'rebooting', waiting: 'waiting', back: 'back', failed: 'timed out', error: 'error' }[phase])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Rolling Reboot</h2>
          {(!started || done) && (
            <button onClick={handleClose} className="text-text-muted hover:text-red">✕</button>
          )}
        </div>

        {!started ? (
          <div className="p-4 space-y-4 overflow-y-auto">
            <p className="text-sm text-text-muted">
              Reboot <span className="text-amber font-mono">{servers.length} server{servers.length !== 1 ? 's' : ''}</span>{' '}
              with <span className="font-mono text-text-primary">reboot_required</span>.
              Servers are processed by ring tag in alphabetical order, in batches of{' '}
              <span className="font-mono text-text-primary">{batchSize}</span>, waiting{' '}
              <span className="font-mono text-text-primary">{waitMinutes} min</span> between batches.
              Each server has up to <span className="font-mono text-text-primary">{timeoutMinutes} min</span> to come back.
            </p>

            <div className="rounded border border-amber/30 bg-amber/5 px-3 py-2 text-xs space-y-1">
              <p className="font-medium text-amber">⚠ This will reboot production servers</p>
              <p className="text-text-muted">
                The rollout aborts before the next batch if any server fails to come back within timeout
                or has a recent error in its update history.
              </p>
            </div>

            <div className="space-y-3">
              {ringNames.map(ring => (
                <div key={ring} className="border border-border rounded">
                  <div className="px-3 py-1.5 border-b border-border bg-surface-2 text-xs font-mono text-text-primary flex items-center justify-between">
                    <span>{ring}</span>
                    <span className="text-text-muted">{rings[ring].length} server{rings[ring].length !== 1 ? 's' : ''}</span>
                  </div>
                  <ul className="divide-y divide-border">
                    {rings[ring].map(s => (
                      <li key={s.id} className="px-3 py-1.5 text-xs font-mono text-text-muted flex items-center justify-between">
                        <span>{s.name}</span>
                        <span className="text-text-muted/70">{s.hostname}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button onClick={start} className="btn-amber">Start Rolling Reboot</button>
              <button onClick={handleClose} className="btn-secondary">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col p-4 gap-3">
            <div className="text-xs font-mono text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
              {activeRing && <span>ring: <span className="text-text-primary">{activeRing}</span></span>}
              {activeBatch && <span>batch: <span className="text-text-primary">{activeBatch.length} server(s)</span></span>}
              {waitingSeconds > 0 && (
                <span className="text-cyan">waiting {Math.floor(waitingSeconds / 60)}m {waitingSeconds % 60}s</span>
              )}
              {aborted && <span className="text-red">aborted ({abortReason})</span>}
              {done && !aborted && <span className="text-green">complete</span>}
            </div>

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
                const phase: RebootPhase = p?.phase ?? 'pending'
                const active = filterServer === s.id
                const color = phaseColor(phase)
                return (
                  <button
                    key={s.id}
                    onClick={() => setFilterServer(active ? null : s.id)}
                    className={`px-2 py-1 rounded text-xs font-mono border transition-colors flex items-center gap-1.5 ${
                      active ? 'bg-surface text-text-primary' : 'text-text-muted hover:text-text-primary'
                    }`}
                    style={{ borderColor: active ? color : undefined, color: active ? color : undefined }}
                    title={phaseLabel(phase)}
                  >
                    <span>{phaseIcon(phase)}</span>
                    <span className="truncate max-w-[100px]">{s.name}</span>
                  </button>
                )
              })}
            </div>

            <div
              className="flex-1 overflow-y-auto bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary min-h-0"
              style={{ maxHeight: '40vh' }}
            >
              {servers
                .filter(s => filterServer === null || filterServer === s.id)
                .map(s => {
                  const p = progress[s.id]
                  const phase: RebootPhase = p?.phase ?? 'pending'
                  return (
                    <div key={s.id} className="flex items-center gap-2 py-0.5">
                      <span style={{ color: phaseColor(phase) }} className="w-4 text-center">{phaseIcon(phase)}</span>
                      <span className="text-text-muted w-32 truncate">[{s.name}]</span>
                      <span style={{ color: phaseColor(phase) }}>{phaseLabel(phase)}</span>
                      {p?.message && <span className="text-text-muted">— {p.message}</span>}
                    </div>
                  )
                })}
              {filterServer === null && logs.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border space-y-0.5">
                  {logs.map((line, i) => (
                    <div key={i} className="text-text-muted">{line}</div>
                  ))}
                </div>
              )}
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
