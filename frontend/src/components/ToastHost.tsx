import { createPortal } from 'react-dom'
import { useToastStore } from '@/hooks/useToast'

const styles: Record<string, string> = {
  success: 'border-green/40 bg-green/10 text-green',
  error: 'border-red/40 bg-red/10 text-red',
  info: 'border-border bg-surface-2 text-text-primary',
}

export default function ToastHost() {
  const { toasts, dismiss } = useToastStore()
  if (toasts.length === 0) return null
  return createPortal(
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`rounded border px-3 py-2 text-sm font-mono shadow-lg cursor-pointer ${styles[t.type] ?? styles.info}`}
          role="status"
        >
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  )
}
