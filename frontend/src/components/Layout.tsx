import { Link, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/hooks/useAuth'

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuthStore()
  const { pathname } = useLocation()

  const nav = [
    { to: '/', label: 'Dashboard' },
    { to: '/history', label: 'History' },
    { to: '/templates', label: 'Templates' },
    { to: '/settings', label: 'Settings' },
  ]

  return (
    <div className="min-h-screen bg-bg text-text-primary font-sans">
      {/* Top bar */}
      <header className="bg-surface border-b border-border h-12 flex items-center px-3 gap-3 sticky top-0 z-40 overflow-x-auto">
        <Link to="/" className="font-mono text-green font-medium tracking-tight text-sm hover:text-green/80 transition-colors shrink-0">
          ⬡ <span className="hidden sm:inline">apt-dashboard</span>
        </Link>
        <nav className="flex gap-0.5 flex-1 overflow-x-auto">
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
    </div>
  )
}
