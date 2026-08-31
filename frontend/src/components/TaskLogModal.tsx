import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Convert from 'ansi-to-html'
import { tasks as tasksApi, type TaskDetail } from '@/api/client'
import { useAuthStore } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { confirmDialog } from '@/hooks/useConfirm'
import { formatDateTime, parseServerDate } from '@/utils/datetime'

const ansiConvert = new Convert({ escapeXML: true })

const TERMINAL_STATUSES = new Set(['success', 'error', 'cancelled', 'interrupted'])

const TASK_TYPE_LABELS: Record<string, string> = {
  upgrade: 'Upgrade',
  upgrade_all: 'Upgrade All',
  reboot_all: 'Rolling Reboot',
  autoremove_all: 'Autoremove All',
  check_all: 'Check All',
  template_apply: 'Apply Template',
}

// Exported for reuse by Dashboard's reattach list, which needs the same label/
// badge treatment for the compact card as the modal uses in its header.
export function taskTypeLabel(taskType: string): string {
  return TASK_TYPE_LABELS[taskType] ?? taskType.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

export function statusBadge(status: TaskDetail['status']): { text: string; className: string } {
  switch (status) {
    case 'queued': return { text: 'Queued', className: 'bg-surface-2 text-text-muted border-border' }
    case 'running': return { text: 'Running', className: 'bg-cyan/10 text-cyan border-cyan/30' }
    case 'success': return { text: 'Success', className: 'bg-green/10 text-green border-green/30' }
    case 'error': return { text: 'Error', className: 'bg-red/10 text-red border-red/30' }
    case 'cancelled': return { text: 'Cancelled', className: 'bg-amber/10 text-amber border-amber/30' }
    // Never rendered as success — a process that died mid-run, not a clean result.
    case 'interrupted': return { text: 'Interrupted', className: 'bg-red/10 text-red border-red/30' }
    default: return { text: status, className: 'bg-surface-2 text-text-muted border-border' }
  }
}

/** "3m 12s" / "42s" style duration, matching the terse style used elsewhere (relativeTime). */
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

interface Props {
  taskId: number
  onClose: () => void
}

/**
 * Reattach-to-in-flight-operation viewer (issue #62). Polls the task's stored
 * transcript via `log_offset` so a reload or a dropped WebSocket doesn't lose
 * the ability to watch (and, for admins, cancel) a run that's still going on
 * the backend. Works purely over REST — it never opens the original WS, so it
 * can reattach to a task started in a different tab, a different browser, or
 * before the current page load.
 */
export default function TaskLogModal({ taskId, onClose }: Props) {
  const { user } = useAuthStore()
  const [task, setTask] = useState<TaskDetail | null>(null)
  const [log, setLog] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  // Forces a re-render every second so the elapsed-time readout keeps ticking
  // while the task is running, without needing its own effect/interval to clean up.
  const [, setTick] = useState(0)

  const offsetRef = useRef(0)
  const mountedRef = useRef(true)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const isTerminal = task ? TERMINAL_STATUSES.has(task.status) : false

  const fetchTask = useCallback(async () => {
    try {
      const detail = await tasksApi.get(taskId, offsetRef.current)
      if (!mountedRef.current) return
      offsetRef.current = detail.log_next_offset
      setTask(detail)
      if (detail.log) setLog(prev => prev + detail.log)
      setLoadError(null)
    } catch (err: unknown) {
      if (!mountedRef.current) return
      setLoadError((err as Error)?.message || 'Failed to load task')
    }
  }, [taskId])

  // Stops on its own once the task reaches a terminal status — no separate
  // teardown needed, usePolling clears its interval whenever `enabled` flips.
  usePolling(fetchTask, 2000, !isTerminal)
  usePolling(() => setTick(t => t + 1), 1000, !isTerminal)

  useEscapeKey(onClose)

  // Keep the transcript pinned to the newest output as it streams in.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  async function handleCancel() {
    if (!task) return
    if (!await confirmDialog({
      message: 'Cancel this task? It stops after the server currently in flight finishes — it never interrupts a running apt transaction.',
      confirmLabel: 'Cancel task',
      danger: true,
    })) return
    setCancelling(true)
    setCancelError(null)
    try {
      const updated = await tasksApi.cancel(task.id)
      if (!mountedRef.current) return
      setTask(prev => (prev ? { ...prev, ...updated } : prev))
    } catch (err: unknown) {
      if (!mountedRef.current) return
      setCancelError((err as Error)?.message || 'Failed to cancel task')
    } finally {
      if (mountedRef.current) setCancelling(false)
    }
  }

  const badge = task ? statusBadge(task.status) : null
  const startedDate = task ? parseServerDate(task.started_at ?? task.created_at) : null
  const endDate = task?.finished_at ? parseServerDate(task.finished_at) : null
  const elapsedMs = startedDate ? (endDate ?? new Date()).getTime() - startedDate.getTime() : null
  const canCancel = !!user?.is_admin && !!task && !isTerminal
  const progressTotal = task?.progress_total ?? 0
  const progressDone = task?.progress_done ?? 0
  const progressPct = progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 gap-3">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="font-mono text-sm text-text-primary font-medium truncate">
              {task ? (task.label || taskTypeLabel(task.task_type)) : `Task #${taskId}`}
            </span>
            {badge && (
              <span className={`badge text-xs border ${badge.className} ${task?.status === 'running' ? 'animate-pulse' : ''}`}>
                {badge.text}
              </span>
            )}
            {task?.server_name && (
              <span className="text-xs text-text-muted font-mono">on {task.server_name}</span>
            )}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors text-lg leading-none shrink-0">×</button>
        </div>

        {/* Meta row */}
        <div className="px-4 py-2 border-b border-border shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted font-mono">
          {task?.initiated_by && <span>Started by <span className="text-text-primary">{task.initiated_by}</span></span>}
          {task && (task.started_at || task.created_at) && (
            <span>Started {formatDateTime(task.started_at ?? task.created_at)}</span>
          )}
          {elapsedMs !== null && (
            <span>{isTerminal ? 'Ran for' : 'Elapsed'} <span className="text-text-primary">{formatDuration(elapsedMs)}</span></span>
          )}
          {progressPct !== null && (
            <span>Progress <span className="text-text-primary">{progressDone}/{progressTotal}</span> ({progressPct}%)</span>
          )}
        </div>

        {/* Interrupted / detail note — always shown honestly, never folded into "success" */}
        {task?.status === 'interrupted' && (
          <div className="px-4 py-2 bg-red/10 border-b border-red/30 text-xs text-red">
            ⚠ Interrupted by an apt-ui restart — its progress and any in-flight SSH work were lost.
            {task.detail ? ` ${task.detail}` : ''}
          </div>
        )}
        {task?.status !== 'interrupted' && task?.detail && (
          <div className="px-4 py-2 bg-surface-2/40 border-b border-border text-xs text-text-muted">
            {task.detail}
          </div>
        )}

        {/* Progress bar */}
        {progressPct !== null && (
          <div className="h-1 bg-surface-2 shrink-0">
            <div
              className={`h-full transition-all ${task?.status === 'error' ? 'bg-red' : task?.status === 'running' ? 'bg-cyan' : 'bg-green'}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}

        {/* Transcript */}
        <div
          ref={logRef}
          className="flex-1 overflow-y-auto bg-bg font-mono text-xs text-text-primary p-3 whitespace-pre-wrap break-words min-h-0"
        >
          {log ? (
            <span dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(log) }} />
          ) : (
            <span className="text-text-muted">
              {loadError ? '' : task ? 'No output yet…' : 'Loading…'}
            </span>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border shrink-0">
          <div className="text-xs text-red font-mono">
            {loadError || cancelError || ''}
          </div>
          <div className="flex items-center gap-2">
            {canCancel && (
              <button onClick={handleCancel} disabled={cancelling} className="btn-danger text-xs disabled:opacity-50">
                {cancelling ? 'Cancelling…' : task?.cancel_requested ? 'Cancel requested…' : 'Cancel'}
              </button>
            )}
            <button onClick={onClose} className="btn-secondary text-xs">Close</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
