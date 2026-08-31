import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { tasks as tasksApi, type Task } from '@/api/client'

export type JobType = 'check-all' | 'upgrade-all' | 'upgrade' | 'selective-upgrade' | 'check'
export type JobStatus = 'running' | 'complete' | 'error'

export interface Job {
  id: string
  type: JobType
  label: string
  status: JobStatus
  /** Navigate here when user clicks the job entry */
  link?: string
  /** Custom action key — e.g. 'restore-upgrade-all' fires a window event */
  action?: string
  startedAt: number
  completedAt?: number
}

/**
 * Fire a job's window action (e.g. `apt:restore-upgrade-all`) so it survives the
 * navigation that usually accompanies it.
 *
 * The upgrade-all restore listener is mounted *inside* the Dashboard, so firing
 * the event before `navigate('/')` from any other page (bell dropdown, command
 * palette) dispatched it into the void: the user landed on the Dashboard with no
 * restored modal and no way to watch the in-flight upgrade. Re-dispatching on the
 * next frames gives the destination route time to mount its listener. Handlers
 * are idempotent (they just re-open the modal), so the extra dispatches are safe.
 */
export function dispatchJobAction(action: string) {
  const fire = () => window.dispatchEvent(new CustomEvent(`apt:${action}`))
  fire()
  requestAnimationFrame(fire)
  setTimeout(fire, 80)
}

// ---------------------------------------------------------------------------
// Reattach to in-flight operations (issue #62)
//
// The backend now persists a `Task` row for every fleet-wide/upgrade operation
// (backend/task_queue.py, backend/routers/tasks.py) so it survives a page
// reload or a dropped WebSocket. `serverTasks` below is that server-side view
// — hydrated on demand via `hydrateFromServer()` — kept deliberately separate
// from the WS-driven, in-memory `jobs` array above rather than merged into it:
// `jobs` entries are transient UI state tied to a live socket in this tab, and
// `Task` rows are the durable record. Callers (Dashboard) combine both via
// `visibleServerTasks()` so a live local job and its own backend Task row never
// render as two separate entries.
// ---------------------------------------------------------------------------

/**
 * Maps a backend Task to the *local* job id it would represent, if this tab
 * happens to also be driving that same operation over a live WebSocket right
 * now. Local job ids are fixed singleton strings per operation kind (see the
 * `addJob` call sites in UpgradeAllModal / RollingRebootModal /
 * AutoremoveAllModal / ServerDetail / Dashboard) rather than the backend's
 * numeric Task id, so the two have to be matched by (task_type, server_id)
 * instead of by id equality.
 *
 * Returns null for task types with no corresponding local job kind (nothing to
 * dedupe against — always show it).
 */
export function localJobIdForTask(task: Task): string | null {
  switch (task.task_type) {
    case 'upgrade_all': return 'upgrade-all'
    case 'reboot_all': return 'reboot-all'
    case 'autoremove_all': return 'autoremove-all'
    case 'upgrade': return task.server_id != null ? `upgrade-${task.server_id}` : null
    default: return null
  }
}

/**
 * Server tasks that should actually be surfaced as "reattachable" — i.e. not
 * already visible as a live, WS-driven local job in *this* tab. A completed
 * local job lingers for AUTO_REMOVE_DELAY before it's removed, but only a
 * 'running' local job should suppress its server-side counterpart: once the
 * local job finishes, the Task card (if the backend still reports it as
 * running/queued for some reason) should reappear rather than staying hidden.
 */
export function visibleServerTasks(jobs: Job[], serverTasks: Task[]): Task[] {
  const activeLocalIds = new Set(jobs.filter(j => j.status === 'running').map(j => j.id))
  return serverTasks.filter(t => {
    const localId = localJobIdForTask(t)
    return localId === null || !activeLocalIds.has(localId)
  })
}

interface JobStore {
  jobs: Job[]
  unseenCount: number
  addJob: (job: Job) => void
  updateJob: (id: string, update: Partial<Pick<Job, 'status' | 'completedAt' | 'label' | 'action'>>) => void
  removeJob: (id: string) => void
  markSeen: () => void
  /** Server-side Task rows currently queued/running — see module doc above. */
  serverTasks: Task[]
  hydratingServerTasks: boolean
  /** Refetch `serverTasks` from GET /api/tasks (status=running + status=queued). */
  hydrateFromServer: () => Promise<void>
}

// Delay before a finished job is auto-removed from the bell list (ms)
const AUTO_REMOVE_DELAY = 3000

export const useJobStore = create<JobStore>()(
  persist(
    (set, get) => ({
      jobs: [],
      unseenCount: 0,
      serverTasks: [],
      hydratingServerTasks: false,

      hydrateFromServer: async () => {
        set({ hydratingServerTasks: true })
        try {
          const [running, queued] = await Promise.all([
            tasksApi.list({ status: 'running', per_page: 100 }),
            tasksApi.list({ status: 'queued', per_page: 100 }),
          ])
          // De-dupe by id defensively — a task could in theory flip from queued
          // to running between the two requests and land in both responses.
          const byId = new Map<number, Task>()
          for (const t of [...running.items, ...queued.items]) byId.set(t.id, t)
          set({ serverTasks: [...byId.values()], hydratingServerTasks: false })
        } catch {
          // Best-effort — leave the previous serverTasks in place rather than
          // blanking a working reattach list over one flaky poll.
          set({ hydratingServerTasks: false })
        }
      },

      addJob: (job) =>
        set((s) => ({
          jobs: [job, ...s.jobs.filter(j => j.id !== job.id)].slice(0, 15),
          unseenCount: 0,
        })),

      updateJob: (id, update) => {
        const prev = get().jobs.find(j => j.id === id)
        const finishing =
          prev?.status === 'running' &&
          (update.status === 'complete' || update.status === 'error')

        set((s) => ({
          jobs: s.jobs.map(j => (j.id === id ? { ...j, ...update } : j)),
          // Surface the amber "unseen completion" dot. Reset by markSeen() when the
          // bell is opened — not by the auto-remove below, so the dot survives the
          // 3s removal and still signals that something finished.
          unseenCount: finishing ? s.unseenCount + 1 : s.unseenCount,
        }))

        if (finishing) {
          setTimeout(() => get().removeJob(id), AUTO_REMOVE_DELAY)
        }
      },

      removeJob: (id) =>
        set((s) => ({
          jobs: s.jobs.filter(j => j.id !== id),
        })),

      markSeen: () => set({ unseenCount: 0 }),
    }),
    {
      name: 'apt-ui:jobs',
      storage: createJSONStorage(() => sessionStorage),
      // Only persist the WS-driven local job list — `serverTasks` is a live
      // cache of GET /api/tasks and must always come from a fresh fetch (via
      // hydrateFromServer, called on app/Dashboard load), never from a stale
      // sessionStorage snapshot from before a restart or another run finished.
      partialize: (state) => ({ jobs: state.jobs, unseenCount: state.unseenCount }),
      // On restore, mark any previously-running jobs as stale
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Clear all jobs on reload — running ones can't still be running after a page refresh
          state.jobs = []
          state.unseenCount = 0
          state.serverTasks = []
        }
      },
    }
  )
)

