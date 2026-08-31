import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/hooks/useAuth'
import { formatDateTime, relativeTime } from '@/utils/datetime'

// ---------------------------------------------------------------------------
// Self-contained API calls (backend/routers/rollouts.py). Not added to
// frontend/src/api/client.ts — this page owns its own fetch wrapper rather
// than touching a file outside its ownership; it mirrors that module's
// credentials/error-shape conventions (see request() in api/client.ts).
// ---------------------------------------------------------------------------

class RolloutApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') detail = body.detail
    } catch { /* ignore */ }
    throw new RolloutApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as unknown as T
  return res.json()
}

type RolloutStatus = 'pending' | 'running' | 'paused' | 'complete' | 'aborted' | 'cancelled'
type StepStatus = 'pending' | 'scheduled' | 'running' | 'success' | 'error' | 'skipped' | 'cancelled'

interface RolloutStep {
  id: number
  rollout_id: number
  step_index: number
  ring_name: string
  status: StepStatus
  scheduled_at: string | null
  started_at: string | null
  finished_at: string | null
  server_ids: number[]
  server_names?: string[]
  detail: string | null
}

interface RolloutTask {
  id: number
  task_type: string
  status: string
  server_id: number | null
  server_name: string | null
  label: string | null
  progress_done: number
  progress_total: number
  started_at: string | null
  finished_at: string | null
  detail: string | null
}

interface RolloutSummary {
  id: number
  kind: string
  status: RolloutStatus
  created_at: string
  started_at: string | null
  finished_at: string | null
  initiated_by: string | null
  config: Record<string, unknown>
  detail: string | null
  steps: RolloutStep[]
  tasks?: RolloutTask[]
}

const rolloutsApi = {
  list: () => api<RolloutSummary[]>('/api/rollouts'),
  get: (id: number) => api<RolloutSummary>(`/api/rollouts/${id}`),
  promote: (id: number) => api<RolloutSummary>(`/api/rollouts/${id}/promote`, { method: 'POST' }),
  pause: (id: number) => api<RolloutSummary>(`/api/rollouts/${id}/pause`, { method: 'POST' }),
  resume: (id: number) => api<RolloutSummary>(`/api/rollouts/${id}/resume`, { method: 'POST' }),
  abort: (id: number) => api<RolloutSummary>(`/api/rollouts/${id}/abort`, { method: 'POST' }),
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const ROLLOUT_STATUS_COLOR: Record<RolloutStatus, string> = {
  pending: 'text-text-muted',
  running: 'text-cyan',
  paused: 'text-amber',
  complete: 'text-green',
  aborted: 'text-red',
  cancelled: 'text-text-muted',
}

const STEP_STATUS_COLOR: Record<StepStatus, string> = {
  pending: 'text-text-muted',
  scheduled: 'text-amber',
  running: 'text-cyan',
  success: 'text-green',
  error: 'text-red',
  skipped: 'text-text-muted',
  cancelled: 'text-text-muted',
}

function StatusPill({ status, colorMap }: { status: string; colorMap: Record<string, string> }) {
  return (
    <span className={`text-xs font-mono uppercase tracking-wide ${colorMap[status] ?? 'text-text-muted'}`}>
      {status}
    </span>
  )
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Rollouts() {
  const isAdmin = useAuthStore(s => s.user?.is_admin ?? false)
  const [rollouts, setRollouts] = useState<RolloutSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [reload, setReload] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await rolloutsApi.list()
      setRollouts(data)
      setError(null)
    } catch (e) {
      setError(errMsg(e, 'Failed to load rollouts'))
    }
  }, [])

  // Poll while anything is still active — a durable rollout can span hours
  // (ring_delay_hours), so this page is meant to be left open/checked back on
  // rather than kept alive by a WebSocket.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const tick = async () => {
      if (cancelled) return
      await load()
    }
    tick()
    timer = setInterval(tick, 8000)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [load, reload])

  const selected = rollouts?.find(r => r.id === selectedId) ?? null

  const runAction = async (id: number, action: 'promote' | 'pause' | 'resume' | 'abort') => {
    setBusyId(id)
    setActionError(null)
    try {
      const fn = { promote: rolloutsApi.promote, pause: rolloutsApi.pause, resume: rolloutsApi.resume, abort: rolloutsApi.abort }[action]
      await fn(id)
      await load()
    } catch (e) {
      setActionError(errMsg(e, `Failed to ${action} rollout ${id}`))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-mono text-text-primary">Rollouts</h1>
        <p className="text-sm text-text-muted">
          Ring-by-ring staged auto-upgrades and window-queued upgrades — durable across a restart.
        </p>
      </div>

      {error && (
        <div className="card border-red/40 bg-red/5 p-3 flex items-center gap-3">
          <span className="text-sm text-red font-mono flex-1 truncate" title={error}>{error}</span>
          <button onClick={() => setReload(n => n + 1)} className="btn-secondary text-xs shrink-0">Retry</button>
        </div>
      )}
      {actionError && (
        <div className="card border-red/40 bg-red/5 p-3 flex items-center gap-3">
          <span className="text-sm text-red font-mono flex-1 truncate" title={actionError}>{actionError}</span>
          <button onClick={() => setActionError(null)} className="btn-secondary text-xs shrink-0">Dismiss</button>
        </div>
      )}

      {rollouts === null && !error && <p className="text-text-muted text-sm">Loading…</p>}

      {rollouts !== null && rollouts.length === 0 && (
        <div className="card p-4 text-sm text-text-muted">
          No rollouts yet. A staged auto-upgrade (Settings → Schedule → "Staged rollout") or a
          window-queued upgrade will show up here.
        </div>
      )}

      <div className="space-y-2">
        {rollouts?.map(r => (
          <RolloutCard
            key={r.id}
            rollout={r}
            expanded={selectedId === r.id}
            onToggle={() => setSelectedId(id => (id === r.id ? null : r.id))}
            isAdmin={isAdmin}
            busy={busyId === r.id}
            onAction={action => runAction(r.id, action)}
          />
        ))}
      </div>

      {selected && (
        <RolloutDetail rollout={selected} />
      )}
    </div>
  )
}

function RolloutCard({
  rollout, expanded, onToggle, isAdmin, busy, onAction,
}: {
  rollout: RolloutSummary
  expanded: boolean
  onToggle: () => void
  isAdmin: boolean
  busy: boolean
  onAction: (action: 'promote' | 'pause' | 'resume' | 'abort') => void
}) {
  const canPromote = isAdmin && (rollout.status === 'running' || rollout.status === 'paused')
    && rollout.steps.some(s => s.status === 'pending' || s.status === 'scheduled')
  const canPause = isAdmin && rollout.status === 'running'
  const canResume = isAdmin && rollout.status === 'paused'
  const canAbort = isAdmin && (rollout.status === 'running' || rollout.status === 'paused' || rollout.status === 'pending')

  const totalSteps = rollout.steps.length
  const doneSteps = rollout.steps.filter(s => s.status === 'success' || s.status === 'skipped').length

  return (
    <div className="card overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-surface/50 transition-colors"
      >
        <span className="text-text-muted font-mono text-xs w-6 shrink-0">#{rollout.id}</span>
        <span className="text-sm text-text-primary font-mono">{rollout.kind}</span>
        <StatusPill status={rollout.status} colorMap={ROLLOUT_STATUS_COLOR} />
        <span className="text-xs text-text-muted">
          {doneSteps}/{totalSteps} ring{totalSteps === 1 ? '' : 's'} done
        </span>
        <span className="text-xs text-text-muted ml-auto">{rollout.initiated_by ?? 'system'}</span>
        <span className="text-xs text-text-muted">{relativeTime(rollout.created_at)}</span>
      </button>

      <div className="flex flex-wrap gap-1 px-3 pb-2">
        {rollout.steps.map(s => (
          <span
            key={s.id}
            title={`${s.ring_name}: ${s.status}${s.detail ? ` — ${s.detail}` : ''}`}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border border-border ${STEP_STATUS_COLOR[s.status] ?? 'text-text-muted'}`}
          >
            {s.ring_name.replace(/^ring:/, '')}
          </span>
        ))}
      </div>

      {(canPromote || canPause || canResume || canAbort) && (
        <div className="flex gap-2 px-3 pb-3">
          {canPromote && (
            <button disabled={busy} onClick={() => onAction('promote')} className="btn-secondary text-xs disabled:opacity-50">
              Promote now
            </button>
          )}
          {canPause && (
            <button disabled={busy} onClick={() => onAction('pause')} className="btn-secondary text-xs disabled:opacity-50">
              Pause
            </button>
          )}
          {canResume && (
            <button disabled={busy} onClick={() => onAction('resume')} className="btn-secondary text-xs disabled:opacity-50">
              Resume
            </button>
          )}
          {canAbort && (
            <button disabled={busy} onClick={() => onAction('abort')} className="btn-secondary text-xs text-red disabled:opacity-50">
              Abort
            </button>
          )}
        </div>
      )}

      {rollout.detail && (
        <div className="px-3 pb-3 text-xs text-text-muted whitespace-pre-line border-t border-border/30 pt-2">
          {rollout.detail}
        </div>
      )}
    </div>
  )
}

function RolloutDetail({ rollout }: { rollout: RolloutSummary }) {
  const [full, setFull] = useState<RolloutSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    rolloutsApi.get(rollout.id)
      .then(d => { if (!cancelled) setFull(d) })
      .catch(e => { if (!cancelled) setError(errMsg(e, 'Failed to load rollout detail')) })
    return () => { cancelled = true }
    // Re-fetch whenever the summary list ticks over for this rollout (its
    // step/status fields changing is a reasonable proxy for "detail changed too").
  }, [rollout.id, rollout.status, rollout.steps.map(s => `${s.status}:${s.finished_at}`).join(',')])

  if (error) return <div className="card p-3 text-sm text-red">{error}</div>
  if (!full) return <div className="card p-3 text-sm text-text-muted">Loading detail…</div>

  return (
    <div className="card overflow-hidden">
      <div className="p-3 border-b border-border">
        <h2 className="text-sm font-mono text-text-primary">Rollout #{full.id} — {full.kind}</h2>
        <p className="text-xs text-text-muted mt-1">
          Created {formatDateTime(full.created_at)}
          {full.started_at && <> · Started {formatDateTime(full.started_at)}</>}
          {full.finished_at && <> · Finished {formatDateTime(full.finished_at)}</>}
        </p>
        {Object.keys(full.config).length > 0 && (
          <p className="text-xs text-text-muted mt-1 font-mono">
            {Object.entries(full.config).map(([k, v]) => `${k}=${v}`).join('  ')}
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="text-left px-3 py-2 font-normal">Ring</th>
              <th className="text-left px-3 py-2 font-normal">Status</th>
              <th className="text-left px-3 py-2 font-normal">Servers</th>
              <th className="text-left px-3 py-2 font-normal">Scheduled</th>
              <th className="text-left px-3 py-2 font-normal">Started</th>
              <th className="text-left px-3 py-2 font-normal">Finished</th>
              <th className="text-left px-3 py-2 font-normal">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {full.steps.map(s => (
              <tr key={s.id} className="hover:bg-surface/50">
                <td className="px-3 py-1.5 text-text-primary">{s.ring_name}</td>
                <td className="px-3 py-1.5"><StatusPill status={s.status} colorMap={STEP_STATUS_COLOR} /></td>
                <td className="px-3 py-1.5 text-text-muted">
                  {(s.server_names ?? s.server_ids.map(id => `#${id}`)).join(', ') || '—'}
                </td>
                <td className="px-3 py-1.5 text-text-muted">{s.scheduled_at ? formatDateTime(s.scheduled_at) : '—'}</td>
                <td className="px-3 py-1.5 text-text-muted">{s.started_at ? formatDateTime(s.started_at) : '—'}</td>
                <td className="px-3 py-1.5 text-text-muted">{s.finished_at ? formatDateTime(s.finished_at) : '—'}</td>
                <td className="px-3 py-1.5 text-text-muted max-w-xs truncate" title={s.detail ?? undefined}>{s.detail ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {full.tasks && full.tasks.length > 0 && (
        <div className="border-t border-border">
          <div className="px-3 py-2 text-xs text-text-muted uppercase tracking-wide">Per-server tasks</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="text-left px-3 py-2 font-normal">Task</th>
                  <th className="text-left px-3 py-2 font-normal">Status</th>
                  <th className="text-left px-3 py-2 font-normal">Progress</th>
                  <th className="text-left px-3 py-2 font-normal">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {full.tasks.map(t => (
                  <tr key={t.id} className="hover:bg-surface/50">
                    <td className="px-3 py-1.5 text-text-primary">{t.label ?? t.task_type}</td>
                    <td className="px-3 py-1.5">
                      <StatusPill
                        status={t.status}
                        colorMap={{
                          queued: 'text-text-muted', running: 'text-cyan', success: 'text-green',
                          error: 'text-red', cancelled: 'text-text-muted', interrupted: 'text-amber',
                        }}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-text-muted">{t.progress_done}/{t.progress_total}</td>
                    <td className="px-3 py-1.5 text-text-muted max-w-xs truncate" title={t.detail ?? undefined}>{t.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
