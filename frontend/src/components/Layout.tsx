import { useState, useRef, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/hooks/useAuth'
import { useJobStore } from '@/hooks/useJobStore'
import { useTheme } from '@/hooks/useTheme'
import { servers as serversApi, releaseCheck as releaseCheckApi, security as securityApi } from '@/api/client'
import type { CveSummary } from '@/types'
import type { ReleaseCheckResult } from '@/api/client'
import type { Job } from '@/hooks/useJobStore'
import CommandPalette from './CommandPalette'

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform)
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function JobRow({ job, onNavigate }: { job: Job; onNavigate: () => void }) {
  const navigate = useNavigate()

  function handleClick() {
    if (job.action) {
      window.dispatchEvent(new CustomEvent(`apt:${job.action}`))
      if (job.link) navigate(job.link)
    } else if (job.link) {
      navigate(job.link)
    }
    onNavigate()
  }

  const icon =
    job.status === 'running' ? (
      <span className="inline-block w-3 h-3 border-2 border-cyan border-t-transparent rounded-full animate-spin shrink-0" />
    ) : job.status === 'complete' ? (
      <span className="text-green text-xs shrink-0">✓</span>
    ) : (
      <span className="text-red text-xs shrink-0">✗</span>
    )

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-2 text-left transition-colors"
    >
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-text-primary truncate">{job.label}</p>
        <p className="text-xs text-text-muted">
          {job.status === 'running' ? 'Running…' : job.status === 'complete' ? 'Completed' : 'Failed'}{' '}
          · {timeAgo(job.startedAt)}
        </p>
      </div>
      {(job.link || job.action) && (
        <span className="text-text-muted/50 text-xs shrink-0">→</span>
      )}
    </button>
  )
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuthStore()
  const { pathname } = useLocation()
  const { jobs, unseenCount, markSeen, updateJob } = useJobStore()
  const { theme, toggle: toggleTheme } = useTheme()
  const [bellOpen, setBellOpen] = useState(false)
  const bellRef = useRef<HTMLDivElement>(null)
  const checkPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Release check (issue #13) — poll once on mount; cached server-side for 6h
  const [releaseInfo, setReleaseInfo] = useState<ReleaseCheckResult | null>(null)
  const [releaseDismissed, setReleaseDismissed] = useState<string | null>(
    () => sessionStorage.getItem('apt-ui:release-dismissed'),
  )
  useEffect(() => {
    releaseCheckApi.status().then(setReleaseInfo).catch(() => {})
  }, [])

  // CVE summary (issue #54) — drives the "Security" nav badge when criticals > 0.
  const [cveSummary, setCveSummary] = useState<CveSummary | null>(null)
  useEffect(() => {
    securityApi.summary().then(setCveSummary).catch(() => {})
  }, [])
  function dismissRelease() {
    if (releaseInfo?.latest) {
      sessionStorage.setItem('apt-ui:release-dismissed', releaseInfo.latest)
      setReleaseDismissed(releaseInfo.latest)
    }
  }
  const showReleaseBanner =
    releaseInfo?.update_available &&
    releaseInfo.latest &&
    releaseDismissed !== releaseInfo.latest

  const running = jobs.filter(j => j.status === 'running')
  const hasRunning = running.length > 0

  // Poll check-all progress from Layout so it resolves even when navigating away
  useEffect(() => {
    const hasRunningCheckAll = jobs.some(j => j.id === 'check-all' && j.status === 'running')
    if (hasRunningCheckAll && !checkPollRef.current) {
      checkPollRef.current = setInterval(async () => {
        try {
          const prog = await serversApi.checkProgress()
          if (!prog.running) {
            clearInterval(checkPollRef.current!)
            checkPollRef.current = null
            updateJob('check-all', { status: 'complete', completedAt: Date.now() })
          }
        } catch {
          clearInterval(checkPollRef.current!)
          checkPollRef.current = null
          updateJob('check-all', { status: 'error', completedAt: Date.now() })
        }
      }, 2000)
    }
    if (!hasRunningCheckAll && checkPollRef.current) {
      clearInterval(checkPollRef.current)
      checkPollRef.current = null
    }
    return () => {
      if (checkPollRef.current) {
        clearInterval(checkPollRef.current)
        checkPollRef.current = null
      }
    }
  }, [jobs, updateJob])

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function openBell() {
    setBellOpen(v => !v)
    if (!bellOpen) markSeen()
  }

  const nav: { to: string; label: string; badge?: number; badgeColor?: string }[] = [
    { to: '/', label: 'Dashboard' },
    { to: '/history', label: 'History' },
    { to: '/templates', label: 'Templates' },
    { to: '/compare', label: 'Compare' },
    { to: '/search', label: 'Search' },
    {
      to: '/security',
      label: 'Security',
      badge: cveSummary?.critical ?? 0,
      badgeColor: 'bg-red/20 text-red border-red/40',
    },
    { to: '/reports', label: 'Reports' },
  ]

  return (
    <div className="min-h-screen bg-bg text-text-primary font-sans">
      {/* Top bar */}
      <header className="bg-surface border-b border-border h-12 flex items-center px-3 gap-3 sticky top-0 z-40">
        <Link to="/" className="font-mono text-green font-medium tracking-tight text-sm hover:text-green/80 transition-colors shrink-0">
          ⬡ <span className="hidden sm:inline">apt-ui</span>
        </Link>
        <nav className="flex gap-0.5 flex-1 overflow-x-auto min-w-0">
          {nav.map(({ to, label, badge, badgeColor }) => (
            <Link
              key={to}
              to={to}
              className={`px-2 sm:px-3 py-1 rounded text-xs sm:text-sm whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                pathname === to
                  ? 'bg-surface-2 text-text-primary'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {label}
              {badge !== undefined && badge > 0 && (
                <span
                  className={`badge border text-[10px] font-mono px-1.5 py-0 leading-tight ${
                    badgeColor ?? 'bg-amber/10 text-amber border-amber/30'
                  }`}
                  title={`${badge} critical CVE${badge === 1 ? '' : 's'}`}
                >
                  {badge}
                </span>
              )}
            </Link>
          ))}
        </nav>

        {/* Activity bell */}
        <div ref={bellRef} className="relative shrink-0">
          <button
            onClick={openBell}
            className="relative w-8 h-8 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors rounded"
            title="Background jobs"
          >
            {/* Bell SVG */}
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
            </svg>
            {/* Spinner ring when running */}
            {hasRunning && (
              <span className="absolute top-0.5 right-0.5 w-2.5 h-2.5 flex items-center justify-center">
                <span className="absolute inline-block w-2.5 h-2.5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
              </span>
            )}
            {/* Unseen badge when not running */}
            {!hasRunning && unseenCount > 0 && (
              <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-amber rounded-full" />
            )}
          </button>

          {bellOpen && (
            <div className="absolute right-0 top-full mt-1 w-72 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <span className="text-xs text-text-muted uppercase tracking-wide">Background Jobs</span>
                {hasRunning && (
                  <span className="text-xs text-cyan font-mono">{running.length} running</span>
                )}
              </div>
              {jobs.length === 0 ? (
                <p className="px-3 py-4 text-xs text-text-muted text-center">No recent jobs</p>
              ) : (
                <div className="max-h-80 overflow-y-auto divide-y divide-border/40">
                  {jobs.map(j => (
                    <JobRow key={j.id} job={j} onNavigate={() => setBellOpen(false)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Command palette hint — opens the palette via Ctrl/Cmd+K */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('apt:open-palette'))}
          className="hidden sm:flex h-7 items-center gap-1 px-2 rounded border border-border text-text-muted hover:text-text-primary hover:border-text-muted/40 transition-colors text-[11px] font-mono shrink-0"
          title="Open command palette"
        >
          <kbd className="text-[10px]">{isMac() ? '⌘' : 'Ctrl'}</kbd>
          <span>K</span>
        </button>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="w-8 h-8 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors rounded shrink-0"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>

        {/* GitHub link */}
        <a
          href="https://github.com/mzac/apt-ui"
          target="_blank"
          rel="noopener noreferrer"
          className="w-8 h-8 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors rounded shrink-0"
          title="View apt-ui on GitHub"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.483 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.579.688.481C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
          </svg>
        </a>

        {/* Settings — placed in the right cluster since it's an admin/account-level page,
            not a daily-browse view like Dashboard/History/etc. */}
        <Link
          to="/settings"
          className={`px-2 py-1 rounded text-xs sm:text-sm whitespace-nowrap transition-colors shrink-0 ${
            pathname === '/settings'
              ? 'bg-surface-2 text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          Settings
        </Link>

        {user && (
          <div className="flex items-center gap-2 text-sm shrink-0">
            <span className="text-text-muted font-mono text-xs hidden sm:inline">{user.username}</span>
            {!user.is_admin && (
              <span className="badge bg-blue/10 text-blue border border-blue/30 text-[10px]" title="Read-only — mutations are disabled">
                read-only
              </span>
            )}
            <button
              onClick={logout}
              className="text-text-muted hover:text-red transition-colors text-xs"
            >
              Logout
            </button>
          </div>
        )}
      </header>

      {showReleaseBanner && releaseInfo && (
        <div className="bg-cyan/10 border-b border-cyan/30 px-4 py-2 text-sm text-cyan flex items-center gap-3">
          <span>🎉</span>
          <span className="font-mono">
            apt-ui <span className="font-medium">{releaseInfo.latest}</span> is available
            {releaseInfo.current && releaseInfo.current !== 'dev' && (
              <span className="text-text-muted"> (you have {releaseInfo.current})</span>
            )}
          </span>
          {releaseInfo.url && (
            <a
              href={releaseInfo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan hover:underline text-xs"
            >
              View release →
            </a>
          )}
          <button
            onClick={dismissRelease}
            className="ml-auto text-cyan/60 hover:text-cyan text-xs"
            title="Dismiss until next session"
          >
            ✕
          </button>
        </div>
      )}

      <main className="p-3 sm:p-4 max-w-full overflow-x-hidden">{children}</main>

      {/* Global command palette — opens via Ctrl/Cmd+K or the nav hint button */}
      <CommandPalette />

      <footer className="border-t border-border/40 px-4 py-2 text-center">
        <span className="text-xs text-text-muted font-mono">
          apt-ui{import.meta.env.VITE_APP_VERSION ? ` ${import.meta.env.VITE_APP_VERSION}` : ''}
        </span>
      </footer>
    </div>
  )
}
