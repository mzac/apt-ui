import { create } from 'zustand'

/**
 * Per-browser layout preferences (issue #105): the order and visibility of the
 * dashboard's sections, which buttons are shown, and which pages appear in the
 * top navigation.
 *
 * Stored in localStorage like the other display preferences (sort order, theme),
 * so they belong to this browser rather than to the account. Hiding something is
 * purely cosmetic — it is not access control. A hidden page is still reachable by
 * URL and from the command palette, and permissions are enforced by the server.
 */

export const SECTIONS = [
  { id: 'summary', label: 'Fleet summary', hint: 'Status tiles, health donut and last-check time' },
  { id: 'trend', label: 'Fleet trend', hint: 'Chart of pending updates over time' },
  { id: 'filters', label: 'Group and tag filters', hint: 'The row of group / tag chips' },
  { id: 'toolbar', label: 'Toolbar', hint: 'Search, sort and the fleet-wide action buttons' },
  { id: 'servers', label: 'Server list', hint: 'Always shown', required: true },
] as const
export type SectionId = typeof SECTIONS[number]['id']

export const BUTTONS = [
  { id: 'add-server', group: 'Toolbar', label: 'Add Server' },
  { id: 'group-view', group: 'Toolbar', label: 'Group' },
  { id: 'density', group: 'Toolbar', label: 'List / Cards' },
  { id: 'refresh-all', group: 'Toolbar', label: 'Refresh All' },
  { id: 'check-all', group: 'Toolbar', label: 'Check All' },
  { id: 'upgrade-all', group: 'Toolbar', label: 'Upgrade All' },
  { id: 'all-updates', group: 'Toolbar', label: 'All Updates' },
  { id: 'card-enable', group: 'Server cards', label: 'Enable / disable' },
  { id: 'card-check', group: 'Server cards', label: 'Check' },
  { id: 'card-upgrade', group: 'Server cards', label: 'Upgrade' },
  { id: 'card-install', group: 'Server cards', label: 'Install' },
  { id: 'card-reboot', group: 'Server cards', label: 'Reboot' },
  { id: 'card-edit', group: 'Server cards', label: 'Edit' },
] as const
export type ButtonId = typeof BUTTONS[number]['id']

/** Pages that can be hidden from the top navigation. The dashboard always stays. */
export const NAV_PAGES = [
  { to: '/history', label: 'History' },
  { to: '/templates', label: 'Templates' },
  { to: '/compare', label: 'Compare' },
  { to: '/search', label: 'Search' },
  { to: '/security', label: 'Security' },
  { to: '/reports', label: 'Reports' },
  { to: '/rollouts', label: 'Rollouts' },
  { to: '/run', label: 'Run' },
] as const

const STORAGE_KEY = 'dashboard:layout'
const DEFAULT_ORDER: SectionId[] = SECTIONS.map(s => s.id)

interface Stored {
  order: SectionId[]
  hiddenSections: SectionId[]
  hiddenButtons: ButtonId[]
  hiddenNav: string[]
}

const DEFAULTS: Stored = { order: DEFAULT_ORDER, hiddenSections: [], hiddenButtons: [], hiddenNav: [] }

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Read and repair the stored value: unknown ids are dropped and sections added in
 *  a later version are appended, so an old or hand-edited entry can't hide the
 *  server list or leave a new section unreachable. */
function load(): Stored {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (parsed && typeof parsed === 'object') raw = parsed
  } catch { /* unreadable storage or bad JSON — fall back to defaults */ }

  const known = new Set<string>(DEFAULT_ORDER)
  const order = [...new Set(strings(raw.order).filter(id => known.has(id)))] as SectionId[]
  for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id)

  const buttonIds = new Set<string>(BUTTONS.map(b => b.id))
  const navPaths = new Set<string>(NAV_PAGES.map(n => n.to))
  return {
    order,
    hiddenSections: strings(raw.hiddenSections).filter(id => known.has(id) && id !== 'servers') as SectionId[],
    hiddenButtons: strings(raw.hiddenButtons).filter(id => buttonIds.has(id)) as ButtonId[],
    hiddenNav: strings(raw.hiddenNav).filter(p => navPaths.has(p)),
  }
}

function save(s: Stored) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* private mode etc. */ }
}

function toggled<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter(x => x !== item) : [...list, item]
}

interface DashboardPrefs extends Stored {
  moveSection: (id: SectionId, delta: -1 | 1) => void
  toggleSection: (id: SectionId) => void
  toggleButton: (id: ButtonId) => void
  toggleNav: (path: string) => void
  reset: () => void
}

export const useDashboardPrefs = create<DashboardPrefs>((set, get) => {
  function update(patch: Partial<Stored>) {
    set(patch)
    const { order, hiddenSections, hiddenButtons, hiddenNav } = get()
    save({ order, hiddenSections, hiddenButtons, hiddenNav })
  }
  return {
    ...load(),
    moveSection: (id, delta) => {
      const order = [...get().order]
      const from = order.indexOf(id)
      const to = from + delta
      if (from < 0 || to < 0 || to >= order.length) return
      ;[order[from], order[to]] = [order[to], order[from]]
      update({ order })
    },
    toggleSection: id => {
      if (id === 'servers') return
      update({ hiddenSections: toggled(get().hiddenSections, id) })
    },
    toggleButton: id => update({ hiddenButtons: toggled(get().hiddenButtons, id) }),
    toggleNav: path => update({ hiddenNav: toggled(get().hiddenNav, path) }),
    reset: () => update({ ...DEFAULTS }),
  }
})

/** `show('check-all')` — true unless the user hid that button. */
export function useButtonVisible(): (id: ButtonId) => boolean {
  const hidden = useDashboardPrefs(s => s.hiddenButtons)
  return id => !hidden.includes(id)
}
