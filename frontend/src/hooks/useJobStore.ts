import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type JobType = 'check-all' | 'upgrade-all' | 'upgrade' | 'selective-upgrade'
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
  markSeen: () => void
}

export const useJobStore = create<JobStore>()(
  persist(
    (set) => ({
      jobs: [],
      unseenCount: 0,

      addJob: (job) =>
        set((s) => ({
          jobs: [job, ...s.jobs.filter(j => j.id !== job.id)].slice(0, 15),
          unseenCount: s.unseenCount + (job.status === 'running' ? 0 : 1),
        })),

      updateJob: (id, update) =>
        set((s) => {
          const prev = s.jobs.find(j => j.id === id)
          const finishing =
            prev?.status === 'running' &&
            (update.status === 'complete' || update.status === 'error')
          return {
            jobs: s.jobs.map(j => (j.id === id ? { ...j, ...update } : j)),
            unseenCount: finishing ? s.unseenCount + 1 : s.unseenCount,
          }
        }),

      markSeen: () => set({ unseenCount: 0 }),
    }),
    {
      name: 'apt-dashboard:jobs',
      storage: createJSONStorage(() => sessionStorage),
      // On restore, mark any previously-running jobs as stale (they can't still be running after a refresh)
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.jobs = state.jobs.map(j =>
            j.status === 'running' ? { ...j, status: 'error', completedAt: j.completedAt ?? Date.now() } : j
          )
        }
      },
    }
  )
)
