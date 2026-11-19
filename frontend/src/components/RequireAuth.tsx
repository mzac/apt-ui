import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/hooks/useAuth'
import ForcePasswordChange from '@/components/ForcePasswordChange'

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, initialized } = useAuthStore()
  const location = useLocation()

  if (!initialized || loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <span className="font-mono text-text-muted animate-pulse">initializing…</span>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // Still on the default password: the backend 403s everything except
  // change-password for this session, so don't mount the app at all.
  if (user.is_default_password) {
    return <ForcePasswordChange />
  }

  return <>{children}</>
}
