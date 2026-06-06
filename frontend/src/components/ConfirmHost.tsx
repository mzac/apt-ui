import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useConfirmStore } from '@/hooks/useConfirm'

export default function ConfirmHost() {
  const { pending, resolve } = useConfirmStore()

  useEffect(() => {
    if (!pending) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') resolve(false)
      if (e.key === 'Enter') resolve(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, resolve])

  if (!pending) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={() => resolve(false)}
    >
      <div
        className="bg-surface border border-border rounded-lg w-full max-w-sm p-5 space-y-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
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
