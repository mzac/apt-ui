import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Escape-key layering
//
// Every overlay (modal, command palette, confirm dialog) used to attach its own
// window-level keydown listener, so a single Escape closed *all* of them at once
// — e.g. the palette opened over a pre-start UpgradeAllModal took both down.
//
// A tiny registry fixes that: each active overlay pushes a layer, and only the
// topmost layer acts on Escape. Layers are pushed once per mount (not on every
// re-render), so a busy modal streaming output underneath can't steal the top
// slot back from the palette above it.
// ---------------------------------------------------------------------------

let _seq = 0
const _stack: number[] = []

function pushLayer(): number {
  const id = ++_seq
  _stack.push(id)
  return id
}

function popLayer(id: number) {
  const i = _stack.indexOf(id)
  if (i !== -1) _stack.splice(i, 1)
}

function isTopLayer(id: number): boolean {
  return _stack.length > 0 && _stack[_stack.length - 1] === id
}

/**
 * True while any overlay is claiming Escape. Used to suppress global hotkeys
 * (e.g. Ctrl/Cmd+K) so the palette can't stack on top of an open dialog.
 */
export function hasEscapeLayer(): boolean {
  return _stack.length > 0
}

/**
 * Calls `handler` when Escape is pressed, while `enabled` is true.
 * Used by modals so Escape closes them (gated so it can't interrupt an in-flight
 * operation). Only the topmost registered layer reacts, so Escape closes one
 * overlay at a time. Listener is cleaned up on unmount / when disabled.
 */
export function useEscapeKey(handler: () => void, enabled = true) {
  // Keep the latest handler in a ref so re-renders don't re-register (and thus
  // re-order) this layer.
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled) return
    const id = pushLayer()
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (!isTopLayer(id)) return  // an overlay above us owns this Escape
      e.preventDefault()
      handlerRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      popLayer(id)
      window.removeEventListener('keydown', onKey)
    }
  }, [enabled])
}
