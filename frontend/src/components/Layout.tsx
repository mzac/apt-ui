import { useState, useRef, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/hooks/useAuth'
import { useJobStore } from '@/hooks/useJobStore'
import { useTheme } from '@/hooks/useTheme'
import { servers as serversApi } from '@/api/client'
import type { Job } from '@/hooks/useJobStore'

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

  const nav = [
    { to: '/', label: 'Dashboard' },
    { to: '/history', label: 'History' },
    { to: '/templates', label: 'Templates' },
    { to: '/compare', label: 'Compare' },
    { to: '/settings', label: 'Settings' },
  ]

  return (
    <div className="min-h-screen bg-bg text-text-primary font-sans">
      {/* Top bar */}
      <header className="bg-surface border-b border-border h-12 flex items-center px-3 gap-3 sticky top-0 z-40">
        <Link to="/" className="font-mono text-green font-medium tracking-tight text-sm hover:text-green/80 transition-colors shrink-0">
          ⬡ <span className="hidden sm:inline">apt-dashboard</span>
        </Link>
        <nav className="flex gap-0.5 flex-1 overflow-x-auto min-w-0">
          {nav.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`px-2 sm:px-3 py-1 rounded text-xs sm:text-sm whitespace-nowrap transition-colors ${
                pathname === to
                  ? 'bg-surface-2 text-text-primary'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {label}
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

        {user && (
          <div className="flex items-center gap-2 text-sm shrink-0">
            <span className="text-text-muted font-mono text-xs hidden sm:inline">{user.username}</span>
            <button
              onClick={logout}
              className="text-text-muted hover:text-red transition-colors text-xs"
            >
              Logout
            </button>
          </div>
        )}
      </header>

      <main className="p-3 sm:p-4 max-w-full overflow-x-hidden">{children}</main>

      <footer className="border-t border-border/40 px-4 py-2 text-center">
        <span className="text-xs text-text-muted font-mono">
          apt-ui{import.meta.env.VITE_APP_VERSION ? ` ${import.meta.env.VITE_APP_VERSION}` : ''}
        </span>
      </footer>
    </div>
  )
}
