import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useConfirmStore } from '@/hooks/useConfirm'
import { useEscapeKey } from '@/hooks/useEscapeKey'

export default function ConfirmHost() {
  const { pending, resolve } = useConfirmStore()
  const dialogRef = useRef<HTMLDivElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  // Escape cancels. Registered through the shared layer registry so it doesn't
  // also close whatever modal sits underneath this dialog.
  useEscapeKey(() => resolve(false), !!pending)

  // Remember what was focused before the dialog opened and restore it on close.
  // The confirm button itself carries autoFocus, so Enter activates *the focused
  // control* natively — there is deliberately no window-level Enter handler:
  // it used to resolve `true` even when Cancel had focus, firing the destructive
  // action (and swallowing the subsequent Cancel click, since the pending dialog
  // was already cleared).
  useEffect(() => {
    if (!pending) return
    prevFocusRef.current = document.activeElement as HTMLElement | null
    return () => prevFocusRef.current?.focus?.()
  }, [pending])

  if (!pending) return null

  function onKeyDown(e: React.KeyboardEvent) {
    // A held-down Enter must not activate the freshly-autofocused confirm button
    // the instant the dialog appears.
    if (e.key === 'Enter' && e.repeat) {
      e.preventDefault()
      return
    }
    // Keep Tab inside the dialog.
    if (e.key === 'Tab') {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])')
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={() => resolve(false)}
    >
      <div
        ref={dialogRef}
        className="bg-surface border border-border rounded-lg w-full max-w-sm p-5 space-y-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={pending.title || 'Confirm'}
      >
        {pending.title && <h3 className="font-mono text-text-primary">{pending.title}</h3>}
        <p className="text-sm text-text-muted whitespace-pre-line">{pending.message}</p>
        <div className="flex justify-end gap-2">
          <button onClick={() => resolve(false)} className="btn-secondary text-sm">
            {pending.cancelLabel ?? 'Cancel'}
          </button>
          <button
            onClick={() => resolve(true)}
            className={`text-sm ${pending.danger ? 'btn-danger' : 'btn-primary'}`}
            autoFocus
          >
            {pending.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
