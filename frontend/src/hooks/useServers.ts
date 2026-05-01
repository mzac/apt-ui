import { create } from 'zustand'
import { servers as serversApi } from '@/api/client'
import type { Server } from '@/types'

interface ServersState {
  servers: Server[]
  loaded: boolean
  loading: boolean
  /** Fetch the server list from the API. Safe to call from any component. */
  load: () => Promise<Server[] | null>
  /** Allow callers (e.g. Dashboard) that already fetched servers to seed the store. */
  setServers: (servers: Server[]) => void
}

/**
 * Lightweight shared store for the fleet server list.
 *
 * The Dashboard and CommandPalette both need an up-to-date list of servers.
 * This store hydrates lazily — `load()` is called from CommandPalette on first
 * open, and Dashboard pushes its periodic poll results in via `setServers()`
 * so the palette stays fresh without duplicating polling work.
 */
export const useServersStore = create<ServersState>((set, get) => ({
  servers: [],
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return null
    set({ loading: true })
    try {
      const list = await serversApi.list()
      set({ servers: list, loaded: true, loading: false })
      return list
    } catch {
      set({ loading: false })
      return null
    }
  },

  setServers: (servers) => set({ servers, loaded: true }),
}))
