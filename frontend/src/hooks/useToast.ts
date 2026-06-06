import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'
export interface Toast { id: number; message: string; type: ToastType }

interface ToastStore {
  toasts: Toast[]
  push: (message: string, type?: ToastType, ms?: number) => void
  dismiss: (id: number) => void
}

let _id = 0

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (message, type = 'info', ms = 4000) => {
    const id = ++_id
    set(s => ({ toasts: [...s.toasts, { id, message, type }] }))
    if (ms > 0) setTimeout(() => get().dismiss(id), ms)
  },
  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}))

// Convenience helpers usable from non-component code (api handlers, stores, etc.).
export const toast = {
  success: (m: string) => useToastStore.getState().push(m, 'success'),
  error: (m: string) => useToastStore.getState().push(m, 'error', 6000),
  info: (m: string) => useToastStore.getState().push(m, 'info'),
}
