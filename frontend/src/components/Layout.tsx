import { Link, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/hooks/useAuth'

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuthStore()
  const { pathname } = useLocation()

  const nav = [
    { to: '/', label: 'Dashboard' },
    { to: '/history', label: 'History' },
    { to: '/settings', label: 'Settings' },
  ]

  return (
    <div className="min-h-screen bg-bg text-text-primary font-sans">
      {/* Top bar */}
      <header className="bg-surface border-b border-border h-12 flex items-center px-4 gap-6 sticky top-0 z-40">
        <Link to="/" className="font-mono text-green font-medium tracking-tight text-sm hover:text-green/80 transition-colors">
          ⬡ apt-dashboard
        </Link>
        <nav className="flex gap-1 flex-1">
          {nav.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`px-3 py-1 rounded text-sm transition-colors ${
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
          <div className="flex items-center gap-3 text-sm">
            <span className="text-text-muted font-mono">{user.username}</span>
            <button
              onClick={logout}
              className="text-text-muted hover:text-red transition-colors"
            >
              Logout
            </button>
          </div>
        )}
      </header>

      <main className="p-4">{children}</main>
    </div>
  )
}
