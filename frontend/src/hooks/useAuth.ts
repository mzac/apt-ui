import { create } from 'zustand'
import type { User } from '@/types'
import { auth } from '@/api/client'

interface AuthState {
  user: User | null
  loading: boolean
  initialized: boolean
  setUser: (user: User | null) => void
  init: () => Promise<void>
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  initialized: false,

  setUser: (user) => set({ user }),

  init: async () => {
    set({ loading: true })
    try {
      const user = await auth.me()
      set({ user, loading: false, initialized: true })
    } catch {
      set({ user: null, loading: false, initialized: true })
    }
  },

  logout: async () => {
    await auth.logout()
    set({ user: null })
    // Clear per-user device-local state so it doesn't leak to the next user on a
    // shared browser (e.g. the command palette's recently-visited servers).
    try { localStorage.removeItem('palette:recentServers') } catch {}
    window.location.href = '/login'
  },
}))
