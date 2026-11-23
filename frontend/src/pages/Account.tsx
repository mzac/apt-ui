import { useSearchParams } from 'react-router-dom'
import { AccountTab } from '@/pages/Settings'
import DisplayPreferences from '@/components/DisplayPreferences'

const TABS = ['Account', 'Display'] as const
type Tab = typeof TABS[number]

/**
 * Personal settings — reached from the username menu in the header (issue #105).
 * Fleet configuration stays on /settings; this page only holds what belongs to the
 * signed-in user: their password, 2FA and API tokens, and how this browser lays
 * out the dashboard.
 */
export default function Account() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'Account'

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-lg font-mono text-text-primary mb-4">Your account</h1>
      <div className="flex gap-1 mb-6 border-b border-border">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setSearchParams({ tab: t }, { replace: true })}
            className={`px-4 py-2 text-sm transition-colors -mb-px border-b-2 ${
              tab === t
                ? 'border-green text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Account' && <AccountTab />}
      {tab === 'Display' && <DisplayPreferences />}
    </div>
  )
}
