import { useEffect, useState } from 'react'
import { auth } from '@/api/client'
import { useAuthStore } from '@/hooks/useAuth'

// Shown instead of the app while the account still has the default password.
// The backend refuses every other request for such a session (403), so nothing
// behind this screen would load anyway — this is the UI for that rule, not the
// enforcement of it.
export default function ForcePasswordChange() {
  const { user, init, logout } = useAuthStore()
  const [minLength, setMinLength] = useState(4)
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    auth.getPasswordPolicy().then(p => setMinLength(p.min_length)).catch(() => {})
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    setError('')
    if (form.new_password.length < minLength) {
      setError(`Password must be at least ${minLength} characters`)
      return
    }
    if (form.new_password !== form.confirm) {
      setError('New passwords do not match')
      return
    }
    setSaving(true)
    try {
      await auth.changePassword(form.current_password, form.new_password)
      // The backend issued a fresh session cookie; re-read the user so the
      // default-password flag clears and the app renders.
      await init()
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-green font-mono text-3xl mb-2">⬡</div>
          <h1 className="font-mono text-xl text-text-primary">apt-ui</h1>
        </div>

        <div className="bg-surface border border-border rounded-lg p-6">
          <div className="mb-4 px-3 py-2 bg-amber/10 border border-amber/30 rounded text-amber text-sm">
            <span className="font-mono">{user?.username}</span> is still using the default password.
            Choose a new one to continue.
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-text-muted mb-1">Current password</label>
              <input
                type="password"
                className="input"
                autoComplete="current-password"
                autoFocus
                value={form.current_password}
                onChange={e => setForm(f => ({ ...f, current_password: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1">New password</label>
              <input
                type="password"
                className="input"
                autoComplete="new-password"
                value={form.new_password}
                onChange={e => setForm(f => ({ ...f, new_password: e.target.value }))}
              />
              <p className="text-xs text-text-muted mt-1">At least {minLength} characters.</p>
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1">Confirm new password</label>
              <input
                type="password"
                className="input"
                autoComplete="new-password"
                value={form.confirm}
                onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))}
              />
            </div>
            {error && <p className="text-red text-sm">{error}</p>}
            <button type="submit" className="btn-primary w-full" disabled={saving}>
              {saving ? 'Changing…' : 'Change password'}
            </button>
          </form>

          <button onClick={logout} className="mt-4 w-full text-xs text-text-muted hover:text-text-primary">
            Log out
          </button>
        </div>
      </div>
    </div>
  )
}
