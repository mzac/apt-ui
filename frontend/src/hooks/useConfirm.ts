import { create } from 'zustand'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface ConfirmState {
  pending: (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  request: (opts: ConfirmOptions) => Promise<boolean>
  resolve: (v: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  request: (opts) => new Promise<boolean>(resolve => {
    // If a confirm is already open (double-click, overlapping actions), resolve the
    // previous one as cancelled so its caller doesn't hang.
    const prev = get().pending
    if (prev) prev.resolve(false)
    set({ pending: { ...opts, resolve } })
  }),
  resolve: (v) => {
    const p = get().pending
    if (p) p.resolve(v)
    set({ pending: null })
  },
}))

/** Promise-based replacement for window.confirm(). Resolves true on confirm. */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === 'string' ? { message: opts } : opts
  return useConfirmStore.getState().request(o)
}
