import { useEffect } from 'react'

/**
 * Calls `handler` when Escape is pressed, while `enabled` is true.
 * Used by modals so Escape closes them (gated so it can't interrupt an in-flight
 * operation). Listener is cleaned up on unmount / when disabled.
 */
export function useEscapeKey(handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        handler()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handler, enabled])
}
