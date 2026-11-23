import { useState } from 'react'
import { useAuthStore } from '@/hooks/useAuth'
import { useDashboardPrefs, SECTIONS, BUTTONS, NAV_PAGES } from '@/hooks/useDashboardPrefs'

const SORT_OPTIONS = [
  { value: 'name',    label: 'Name' },
  { value: 'status',  label: 'Status' },
  { value: 'updates', label: 'Update count' },
  { value: 'group',   label: 'Group' },
] as const

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onChange} className="w-4 h-4 accent-green" />
      {label}
    </label>
  )
}

/**
 * Display preferences — everything here is stored in this browser's localStorage,
 * never on the server. Lives on the Account page (issue #105).
 */
export default function DisplayPreferences() {
  const { user } = useAuthStore()
  const prefs = useDashboardPrefs()
  const [defaultSort, setDefaultSort] = useState(
    () => localStorage.getItem('dashboard:sortBy') ?? 'status'
  )
  const [alwaysShowReboot, setAlwaysShowReboot] = useState(
    () => localStorage.getItem('dashboard:alwaysShowReboot') === 'true'
  )

  function handleSortChange(v: string) {
    setDefaultSort(v)
    localStorage.setItem('dashboard:sortBy', v)
  }

  function handleAlwaysShowRebootChange(v: boolean) {
    setAlwaysShowReboot(v)
    localStorage.setItem('dashboard:alwaysShowReboot', String(v))
  }

  const sections = prefs.order.map(id => SECTIONS.find(s => s.id === id)!)
  const buttonGroups = [...new Set(BUTTONS.map(b => b.group))]
  // Run is admin-only, and "Add Server" only ever shows for admins.
  const navPages = NAV_PAGES.filter(n => n.to !== '/run' || user?.is_admin)
  const buttons = BUTTONS.filter(b => b.id !== 'add-server' || user?.is_admin)
  const customised =
    prefs.hiddenSections.length + prefs.hiddenButtons.length + prefs.hiddenNav.length > 0 ||
    prefs.order.some((id, i) => id !== SECTIONS[i].id)

  return (
    <div className="space-y-6 max-w-xl">
      <p className="text-xs text-text-muted">
        These preferences are stored in your browser and apply only to this device. Hiding something
        only tidies the screen — it does not change what your account is allowed to do.
      </p>

      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Dashboard sections</h2>
        <p className="text-xs text-text-muted">Choose which sections the dashboard shows, and in what order.</p>
        <ul className="divide-y divide-border/40 border border-border rounded">
          {sections.map((s, i) => {
            const required = 'required' in s && s.required
            const visible = !prefs.hiddenSections.includes(s.id)
            return (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-green disabled:opacity-50"
                  checked={visible}
                  disabled={required}
                  onChange={() => prefs.toggleSection(s.id)}
                  aria-label={`Show ${s.label}`}
                />
                <div className={`flex-1 min-w-0 ${visible ? '' : 'opacity-50'}`}>
                  <div className="text-sm text-text-primary">{s.label}</div>
                  <div className="text-xs text-text-muted">{s.hint}</div>
                </div>
                <button
                  type="button"
                  className="btn-secondary text-xs py-0.5 px-2 disabled:opacity-30"
                  disabled={i === 0}
                  onClick={() => prefs.moveSection(s.id, -1)}
                  aria-label={`Move ${s.label} up`}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs py-0.5 px-2 disabled:opacity-30"
                  disabled={i === sections.length - 1}
                  onClick={() => prefs.moveSection(s.id, 1)}
                  aria-label={`Move ${s.label} down`}
                  title="Move down"
                >
                  ↓
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Buttons</h2>
        <p className="text-xs text-text-muted">
          Untick the buttons you never use. Everything stays available on each server's own page.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {buttonGroups.map(group => (
            <div key={group} className="space-y-2">
              <div className="label mb-0">{group}</div>
              {buttons.filter(b => b.group === group).map(b => (
                <Toggle
                  key={b.id}
                  label={b.label}
                  checked={!prefs.hiddenButtons.includes(b.id)}
                  onChange={() => prefs.toggleButton(b.id)}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="border-t border-border/40 pt-3">
          <Toggle
            label="Always show the Reboot button on the server page"
            checked={alwaysShowReboot}
            onChange={() => handleAlwaysShowRebootChange(!alwaysShowReboot)}
          />
          <p className="text-xs text-text-muted mt-1 pl-6">
            Otherwise it only appears when the server reports that a reboot is needed.
          </p>
        </div>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Navigation</h2>
        <p className="text-xs text-text-muted">
          Pages shown in the top bar. Hidden pages can still be opened from the command palette.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {navPages.map(n => (
            <Toggle
              key={n.to}
              label={n.label}
              checked={!prefs.hiddenNav.includes(n.to)}
              onChange={() => prefs.toggleNav(n.to)}
            />
          ))}
        </div>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Sorting</h2>
        <div>
          <label className="label">Default dashboard sort order</label>
          <select className="input w-48" value={defaultSort} onChange={e => handleSortChange(e.target.value)}>
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1">Takes effect on the next page load. Changing the sort on the dashboard also updates this.</p>
        </div>
      </section>

      <button type="button" className="btn-secondary text-xs" disabled={!customised} onClick={prefs.reset}>
        Reset layout to defaults
      </button>
    </div>
  )
}
