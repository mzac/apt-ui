import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { auth } from '@/api/client'
import { useAuthStore } from '@/hooks/useAuth'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [needs2fa, setNeeds2fa] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { setUser, user } = useAuthStore()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const expired = searchParams.get('expired') === '1'

  useEffect(() => {
    if (user) navigate('/', { replace: true })
  }, [user, navigate])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const u = await auth.login(username, password, needs2fa ? totpCode : undefined)
      setUser(u)
      navigate('/', { replace: true })
    } catch (err: unknown) {
      const msg = (err as Error).message || 'Login failed'
      // Backend signals 2FA needed via the error detail (issue #18)
      if (msg.includes('2FA code required')) {
        setNeeds2fa(true)
        setError('')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-green font-mono text-3xl mb-2">⬡</div>
          <h1 className="font-mono text-xl text-text-primary">apt-ui</h1>
          <p className="text-text-muted text-sm mt-1">Fleet update manager</p>
        </div>

        <div className="bg-surface border border-border rounded-lg p-6">
          {expired && (
            <div className="mb-4 px-3 py-2 bg-amber/10 border border-amber/30 rounded text-amber text-sm">
              Session expired — please log in again.
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-text-muted mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-green"
                autoFocus
                autoComplete="username"
              />
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-green"
                autoComplete="current-password"
              />
            </div>

            {needs2fa && (
              <div>
                <label className="block text-sm text-text-muted mb-1">2FA code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={totpCode}
                  onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-base font-mono text-text-primary focus:outline-none focus:border-green tracking-widest text-center"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="000000"
                />
                <p className="text-xs text-text-muted mt-1">Enter the 6-digit code from your authenticator app.</p>
              </div>
            )}

            {error && (
              <p className="text-red text-sm">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-green text-bg font-medium py-2 rounded text-sm hover:bg-green/90 transition-colors disabled:opacity-50"
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
