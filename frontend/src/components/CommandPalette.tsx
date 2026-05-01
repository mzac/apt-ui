import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/hooks/useAuth'
import { useJobStore } from '@/hooks/useJobStore'
import { useServersStore } from '@/hooks/useServers'
import { servers as serversApi } from '@/api/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Category = 'server' | 'recent-server' | 'page' | 'settings' | 'job' | 'action'

interface CommandItem {
  id: string
  category: Category
  label: string
  hint?: string
  icon?: string
  /** Lowercased searchable string built from label + hint. */
  haystack: string
  perform: () => void
}

const CATEGORY_LABEL: Record<Category, string> = {
  'server': 'Servers',
  'recent-server': 'Recent',
  'page': 'Pages',
  'settings': 'Settings',
  'job': 'Recent Jobs',
  'action': 'Actions',
}

const CATEGORY_ORDER: Category[] = ['recent-server', 'server', 'page', 'settings', 'action', 'job']

const RECENT_KEY = 'palette:recentServers'
const RECENT_MAX = 5

// ---------------------------------------------------------------------------
// Recent server tracking
// ---------------------------------------------------------------------------

function loadRecent(): number[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((n) => typeof n === 'number').slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** Push a server id to the recent list. Dedupes and caps at RECENT_MAX. */
export function pushRecentServer(id: number) {
  try {
    const current = loadRecent().filter((n) => n !== id)
    current.unshift(id)
    localStorage.setItem(RECENT_KEY, JSON.stringify(current.slice(0, RECENT_MAX)))
  } catch {
    // localStorage may be unavailable (private mode) — silently ignore
  }
}

// ---------------------------------------------------------------------------
// Fuzzy matcher — substring match with prefix bonus.
// ---------------------------------------------------------------------------

interface MatchResult {
  score: number
  /** Indices of matched characters in the haystack — used to highlight. */
  positions: number[]
}

/**
 * Score = +100 for a substring hit, +50 prefix bonus, +20 word-start bonus.
 * Returns null if the query characters don't all appear in order.
 */
function fuzzyMatch(query: string, haystack: string): MatchResult | null {
  if (!query) return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const h = haystack.toLowerCase()

  // Substring fast path
  const idx = h.indexOf(q)
  if (idx !== -1) {
    const positions: number[] = []
    for (let i = 0; i < q.length; i++) positions.push(idx + i)
    let score = 100 + (q.length * 5)
    if (idx === 0) score += 50
    else if (h[idx - 1] === ' ' || h[idx - 1] === '-' || h[idx - 1] === '.') score += 20
    return { score, positions }
  }

  // Subsequence fallback — every query char must appear in order
  let hi = 0
  const positions: number[] = []
  let consecutive = 0
  let score = 0
  for (let qi = 0; qi < q.length; qi++) {
    let found = -1
    while (hi < h.length) {
      if (h[hi] === q[qi]) {
        found = hi
        break
      }
      hi++
    }
    if (found === -1) return null
    positions.push(found)
    if (positions.length > 1 && positions[positions.length - 2] === found - 1) {
      consecutive++
      score += 5
    } else {
      consecutive = 0
    }
    if (found === 0 || h[found - 1] === ' ' || h[found - 1] === '-' || h[found - 1] === '.') {
      score += 8
    }
    score += 1
    hi++
  }
  return { score, positions }
}

// ---------------------------------------------------------------------------
// Highlight helper — bolds matched character positions.
// ---------------------------------------------------------------------------

function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>
  const parts: React.ReactNode[] = []
  let last = 0
  const set = new Set(positions)
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (i > last) parts.push(<span key={`p-${last}`}>{text.slice(last, i)}</span>)
      parts.push(
        <span key={`m-${i}`} className="text-green font-semibold">{text[i]}</span>
      )
      last = i + 1
    }
  }
  if (last < text.length) parts.push(<span key={`p-${last}`}>{text.slice(last)}</span>)
  return <>{parts}</>
}

// ---------------------------------------------------------------------------
// CommandPalette
// ---------------------------------------------------------------------------

type FilterChip = 'all' | Category

const CHIPS: { id: FilterChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'server', label: 'Servers' },
  { id: 'page', label: 'Pages' },
  { id: 'settings', label: 'Settings' },
  { id: 'action', label: 'Actions' },
  { id: 'job', label: 'Jobs' },
]

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [filter, setFilter] = useState<FilterChip>('all')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const navigate = useNavigate()
  const { logout } = useAuthStore()
  const { jobs } = useJobStore()
  const { servers, loaded, load, setServers } = useServersStore()

  // ----- open/close --------------------------------------------------------

  const openPalette = useCallback(() => {
    setQuery('')
    setActiveIdx(0)
    setFilter('all')
    setOpen(true)
  }, [])

  const closePalette = useCallback(() => setOpen(false), [])

  // Listen for Ctrl+K / Cmd+K globally + a custom event so the nav button can trigger it
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isOpen = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)
      if (isOpen) {
        e.preventDefault()
        setOpen((v) => {
          if (v) return false
          setQuery('')
          setActiveIdx(0)
          setFilter('all')
          return true
        })
      }
    }
    function onCustomOpen() {
      openPalette()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('apt:open-palette', onCustomOpen as EventListener)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('apt:open-palette', onCustomOpen as EventListener)
    }
  }, [openPalette])

  // Hydrate the server list when the palette is first opened
  useEffect(() => {
    if (open && !loaded) {
      load()
    }
  }, [open, loaded, load])

  // Focus input on open
  useEffect(() => {
    if (open) {
      // Defer to next paint so the input is mounted
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  // ----- build items -------------------------------------------------------

  const items = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = []

    // Recent servers (last 5 visited)
    const recentIds = loadRecent()
    const recentServers = recentIds
      .map((id) => servers.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
    for (const s of recentServers) {
      out.push({
        id: `recent-server-${s.id}`,
        category: 'recent-server',
        label: s.name,
        hint: s.hostname,
        icon: 'recent',
        haystack: `${s.name} ${s.hostname}`.toLowerCase(),
        perform: () => {
          pushRecentServer(s.id)
          navigate(`/servers/${s.id}`)
        },
      })
    }

    // All servers (skip those already shown as "recent")
    const recentSet = new Set(recentIds)
    for (const s of servers) {
      if (recentSet.has(s.id)) continue
      out.push({
        id: `server-${s.id}`,
        category: 'server',
        label: s.name,
        hint: s.hostname,
        icon: 'server',
        haystack: `${s.name} ${s.hostname}`.toLowerCase(),
        perform: () => {
          pushRecentServer(s.id)
          navigate(`/servers/${s.id}`)
        },
      })
    }

    // Top-level pages
    const pages: { label: string; path: string; hint?: string }[] = [
      { label: 'Dashboard', path: '/', hint: 'Fleet overview' },
      { label: 'History', path: '/history', hint: 'Upgrade and notification history' },
      { label: 'Templates', path: '/templates', hint: 'Package templates' },
      { label: 'Compare', path: '/compare', hint: 'Compare packages across servers' },
      { label: 'Search', path: '/search', hint: 'Fleet-wide package search' },
      { label: 'Reports', path: '/reports', hint: 'Upgrade activity reports' },
      { label: 'Settings', path: '/settings', hint: 'Configure apt-ui' },
    ]
    for (const p of pages) {
      out.push({
        id: `page-${p.path}`,
        category: 'page',
        label: p.label,
        hint: p.hint,
        icon: 'page',
        haystack: `${p.label} ${p.hint ?? ''}`.toLowerCase(),
        perform: () => navigate(p.path),
      })
    }

    // Settings sub-pages — issue requests Schedule, Hooks, Maintenance,
    // Notifications, Users, Servers, Account. The actual Settings.tsx tabs
    // are: Servers, Schedule, Preferences, Notifications, Infrastructure,
    // Users, Account, Backup. Hooks + Maintenance live inside the Schedule
    // tab so they all link to ?tab=Schedule.
    const settingsTabs: { label: string; tab: string; hint?: string }[] = [
      { label: 'Schedule', tab: 'Schedule', hint: 'Cron-based check + auto-upgrade' },
      { label: 'Hooks', tab: 'Schedule', hint: 'Pre/post-upgrade hooks' },
      { label: 'Maintenance Windows', tab: 'Schedule', hint: 'When upgrades may run' },
      { label: 'Notifications', tab: 'Notifications', hint: 'Email + webhook config' },
      { label: 'Users', tab: 'Users', hint: 'Multi-user management' },
      { label: 'Servers', tab: 'Servers', hint: 'Add or edit servers' },
      { label: 'Account', tab: 'Account', hint: 'Password, 2FA, API tokens' },
      { label: 'Preferences', tab: 'Preferences', hint: 'Concurrency, retention' },
      { label: 'Infrastructure', tab: 'Infrastructure', hint: 'Tailscale + apt-cacher-ng' },
      { label: 'Backup', tab: 'Backup', hint: 'Export / import config' },
    ]
    for (const s of settingsTabs) {
      out.push({
        id: `settings-${s.label}`,
        category: 'settings',
        label: `Settings · ${s.label}`,
        hint: s.hint,
        icon: 'settings',
        haystack: `settings ${s.label} ${s.hint ?? ''}`.toLowerCase(),
        perform: () => navigate(`/settings?tab=${encodeURIComponent(s.tab)}`),
      })
    }

    // Recent jobs (last 5)
    for (const j of jobs.slice(0, 5)) {
      const statusLabel =
        j.status === 'running' ? 'running' :
        j.status === 'complete' ? 'completed' : 'failed'
      out.push({
        id: `job-${j.id}-${j.startedAt}`,
        category: 'job',
        label: j.label,
        hint: statusLabel,
        icon: 'job',
        haystack: `${j.label} ${statusLabel}`.toLowerCase(),
        perform: () => {
          if (j.action) {
            window.dispatchEvent(new CustomEvent(`apt:${j.action}`))
            if (j.link) navigate(j.link)
          } else if (j.link) {
            navigate(j.link)
          }
        },
      })
    }

    // Actions
    const actions: { label: string; hint: string; perform: () => void }[] = [
      {
        label: 'Check All',
        hint: 'Run apt update on every enabled server',
        perform: async () => {
          try {
            await serversApi.checkAll()
            window.dispatchEvent(new CustomEvent('apt:refresh'))
          } catch {
            // Errors surface in the dashboard — the palette stays silent
          }
        },
      },
      {
        label: 'Refresh All',
        hint: 'Re-poll status without re-running apt update',
        perform: async () => {
          try {
            await serversApi.refreshAll()
            window.dispatchEvent(new CustomEvent('apt:refresh'))
          } catch {}
        },
      },
      {
        label: 'New template',
        hint: 'Create a package template',
        perform: () => navigate('/templates'),
      },
      {
        label: 'Add server',
        hint: 'Open the server settings page',
        perform: () => navigate('/settings?tab=Servers'),
      },
      {
        label: 'Logout',
        hint: 'Sign out of apt-ui',
        perform: () => { logout() },
      },
    ]
    for (const a of actions) {
      out.push({
        id: `action-${a.label}`,
        category: 'action',
        label: a.label,
        hint: a.hint,
        icon: 'action',
        haystack: `${a.label} ${a.hint}`.toLowerCase(),
        perform: a.perform,
      })
    }

    return out
  }, [servers, jobs, navigate, logout])

  // ----- filter + score ----------------------------------------------------

  const matched = useMemo(() => {
    const filtered = items.filter((it) => {
      if (filter === 'all') return true
      if (filter === 'server') return it.category === 'server' || it.category === 'recent-server'
      return it.category === filter
    })

    if (!query.trim()) {
      return filtered.map((item) => ({ item, positions: [] as number[], score: 0 }))
    }

    const q = query.trim().toLowerCase()
    const scored: { item: CommandItem; positions: number[]; score: number }[] = []
    for (const it of filtered) {
      const m = fuzzyMatch(q, it.haystack)
      if (!m) continue
      // Keep label-position highlight, mapping haystack indices that fall in
      // the label slice. Since haystack starts with `${label} ...` this is
      // a clean prefix slice of positions <= label.length.
      const labelLen = it.label.length
      const labelPositions = m.positions.filter((p) => p < labelLen)
      scored.push({ item: it, positions: labelPositions, score: m.score })
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.item.label.localeCompare(b.item.label)
    })
    return scored
  }, [items, query, filter])

  // Group results by category for rendering
  const grouped = useMemo(() => {
    const buckets = new Map<Category, typeof matched>()
    for (const m of matched) {
      const arr = buckets.get(m.item.category)
      if (arr) arr.push(m)
      else buckets.set(m.item.category, [m])
    }
    const order: { cat: Category; entries: typeof matched }[] = []
    for (const cat of CATEGORY_ORDER) {
      const entries = buckets.get(cat)
      if (entries && entries.length) order.push({ cat, entries })
    }
    return order
  }, [matched])

  // Flat list of items in render order — used by the keyboard navigator
  const flat = useMemo(() => grouped.flatMap((g) => g.entries), [grouped])

  // Clamp activeIdx whenever the result set changes
  useEffect(() => {
    if (activeIdx >= flat.length) setActiveIdx(0)
  }, [flat.length, activeIdx])

  // ----- key handling inside the palette ----------------------------------

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = flat[activeIdx]
      if (target) {
        target.item.perform()
        closePalette()
      }
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const idx = CHIPS.findIndex((c) => c.id === filter)
      const next = e.shiftKey
        ? CHIPS[(idx - 1 + CHIPS.length) % CHIPS.length]
        : CHIPS[(idx + 1) % CHIPS.length]
      setFilter(next.id)
      setActiveIdx(0)
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh]"
      onClick={closePalette}
    >
      <div
        className="bg-surface border border-border rounded-lg w-full max-w-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label="Command palette"
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <span className="text-text-muted text-sm" aria-hidden>⌕</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0) }}
            placeholder="Type a server, page, or command…"
            className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder-text-muted font-mono"
          />
          <kbd className="text-[10px] text-text-muted font-mono border border-border rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-border">
          {CHIPS.map((c) => (
            <button
              key={c.id}
              onClick={() => { setFilter(c.id); setActiveIdx(0); inputRef.current?.focus() }}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                filter === c.id
                  ? 'bg-green/20 text-green border border-green/40'
                  : 'bg-surface-2 text-text-muted border border-border hover:text-text-primary'
              }`}
              tabIndex={-1}
            >
              {c.label}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-text-muted font-mono self-center">
            Tab to filter · ↑↓ to move · ↵ to select
          </span>
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto max-h-[55vh]">
          {flat.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-text-muted">
              No matches.
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.cat}>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-text-muted bg-surface-2/40">
                  {CATEGORY_LABEL[group.cat]}
                </div>
                {group.entries.map((entry) => {
                  const idx = flat.indexOf(entry)
                  const active = idx === activeIdx
                  return (
                    <button
                      key={entry.item.id}
                      data-idx={idx}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => { entry.item.perform(); closePalette() }}
                      className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                        active ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-2/60'
                      }`}
                    >
                      <CategoryIcon category={entry.item.category} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-text-primary truncate">
                          <Highlight text={entry.item.label} positions={entry.positions} />
                        </div>
                        {entry.item.hint && (
                          <div className="text-xs text-text-muted truncate">{entry.item.hint}</div>
                        )}
                      </div>
                      {active && (
                        <span className="text-[10px] text-text-muted font-mono shrink-0">↵</span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// Tiny icons — keep inline as SVG so we don't pull in a dependency
// ---------------------------------------------------------------------------

function CategoryIcon({ category }: { category: Category }) {
  const cls = 'w-4 h-4 shrink-0'
  switch (category) {
    case 'server':
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className={`${cls} text-cyan`}>
          <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm0 8a1 1 0 011-1h12a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4zm3-7a1 1 0 100 2 1 1 0 000-2zm0 8a1 1 0 100 2 1 1 0 000-2z" />
        </svg>
      )
    case 'recent-server':
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className={`${cls} text-amber`}>
          <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm.75 4.25a.75.75 0 00-1.5 0V10c0 .2.08.39.22.53l2.5 2.5a.75.75 0 101.06-1.06l-2.28-2.28V6.25z" />
        </svg>
      )
    case 'page':
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className={`${cls} text-blue`}>
          <path d="M4 3a1 1 0 011-1h7l4 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1V3zm8 0v3h3l-3-3z" />
        </svg>
      )
    case 'settings':
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className={`${cls} text-text-muted`}>
          <path fillRule="evenodd" d="M11.5 2a1 1 0 00-1-1h-1a1 1 0 00-1 1v.6a6 6 0 00-1.6.66l-.42-.42a1 1 0 00-1.42 0l-.7.7a1 1 0 000 1.42l.42.42A6 6 0 002.6 7.5H2a1 1 0 00-1 1v1a1 1 0 001 1h.6a6 6 0 00.66 1.6l-.42.42a1 1 0 000 1.42l.7.7a1 1 0 001.42 0l.42-.42a6 6 0 001.6.66V16a1 1 0 001 1h1a1 1 0 001-1v-.6a6 6 0 001.6-.66l.42.42a1 1 0 001.42 0l.7-.7a1 1 0 000-1.42l-.42-.42a6 6 0 00.66-1.6H16a1 1 0 001-1v-1a1 1 0 00-1-1h-.6a6 6 0 00-.66-1.6l.42-.42a1 1 0 000-1.42l-.7-.7a1 1 0 00-1.42 0l-.42.42a6 6 0 00-1.6-.66V2zM10 13a4 4 0 100-8 4 4 0 000 8z" clipRule="evenodd" />
        </svg>
      )
    case 'job':
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className={`${cls} text-green`}>
          <path d="M10 2a8 8 0 110 16 8 8 0 010-16zm3.7 5.7a1 1 0 10-1.4-1.4L9 9.6 7.7 8.3a1 1 0 10-1.4 1.4l2 2a1 1 0 001.4 0l4-4z" />
        </svg>
      )
    case 'action':
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className={`${cls} text-amber`}>
          <path d="M11.3 1.3a1 1 0 00-1.7.45L8.4 7.5H4a1 1 0 00-.7 1.7l5.4 5.4a1 1 0 001.7-.45L11.6 12.5H16a1 1 0 00.7-1.7l-5.4-5.4z" />
        </svg>
      )
  }
}

// Re-export the store helper for callers that just want to record a visit
// without instantiating the palette.
export { useServersStore as _useServersStore }
