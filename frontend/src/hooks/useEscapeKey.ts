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

interface Layer { id: number; enabled: boolean }

let _seq = 0
const _stack: Layer[] = []

// Layers are pushed on MOUNT and carry their enabled state, rather than being
// pushed/popped as `enabled` toggles. Re-pushing on every toggle would move an
// overlay back to the top of the stack: a fleet modal whose Escape is disabled
// while running would, the moment the run finished, jump above a confirm dialog
// opened over it — and Escape would then close the modal and orphan the dialog
// with an unresolved promise.
function pushLayer(enabled: boolean): number {
  const id = ++_seq
  _stack.push({ id, enabled })
  return id
}

function popLayer(id: number) {
  const i = _stack.findIndex(l => l.id === id)
  if (i !== -1) _stack.splice(i, 1)
}

function setLayerEnabled(id: number, enabled: boolean) {
  const layer = _stack.find(l => l.id === id)
  if (layer) layer.enabled = enabled
}

/** The topmost layer that is actually claiming Escape. */
function isTopLayer(id: number): boolean {
  for (let i = _stack.length - 1; i >= 0; i--) {
    if (_stack[i].enabled) return _stack[i].id === id
  }
  return false
}

/**
 * True while any overlay is claiming Escape. Used to suppress global hotkeys
 * (e.g. Ctrl/Cmd+K) so the palette can't stack on top of an open dialog.
 * Only *enabled* layers count, so a modal that has deliberately released Escape
 * (e.g. mid-run) doesn't silently disable the palette hotkey.
 */
export function hasEscapeLayer(): boolean {
  return _stack.some(l => l.enabled)
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
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const idRef = useRef<number | null>(null)

  // Registration is tied to mount so the stack order matches the visual order of
  // the overlays; `enabled` only decides whether this layer currently claims Escape.
  useEffect(() => {
    const id = pushLayer(enabledRef.current)
    idRef.current = id
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (!enabledRef.current) return
      if (!isTopLayer(id)) return  // an overlay above us owns this Escape
      e.preventDefault()
      handlerRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      popLayer(id)
      idRef.current = null
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    if (idRef.current !== null) setLayerEnabled(idRef.current, enabled)
  }, [enabled])
}
