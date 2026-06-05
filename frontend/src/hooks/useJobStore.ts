import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

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

interface JobStore {
  jobs: Job[]
  unseenCount: number
  addJob: (job: Job) => void
  updateJob: (id: string, update: Partial<Pick<Job, 'status' | 'completedAt' | 'label' | 'action'>>) => void
  removeJob: (id: string) => void
  markSeen: () => void
}

// Delay before a finished job is auto-removed from the bell list (ms)
const AUTO_REMOVE_DELAY = 3000

export const useJobStore = create<JobStore>()(
  persist(
    (set, get) => ({
      jobs: [],
      unseenCount: 0,

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
      // On restore, mark any previously-running jobs as stale
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Clear all jobs on reload — running ones can't still be running after a page refresh
          state.jobs = []
          state.unseenCount = 0
        }
      },
    }
  )
)

