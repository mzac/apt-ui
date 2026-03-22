import { useState, useEffect, useCallback } from 'react'
import { servers as serversApi, groups as groupsApi, scheduler as schedulerApi, notifications as notifApi, auth } from '@/api/client'
import type { Server, ServerGroup, ScheduleConfig, NotificationConfig } from '@/types'
import { useAuthStore } from '@/hooks/useAuth'

const TABS = ['Servers', 'Schedule', 'Notifications', 'Account'] as const
type Tab = typeof TABS[number]

// ---------------------------------------------------------------------------
// Main Settings page
// ---------------------------------------------------------------------------
export default function Settings() {
  const [tab, setTab] = useState<Tab>('Servers')

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-lg font-mono text-text-primary mb-4">Settings</h1>
      <div className="flex gap-1 mb-6 border-b border-border">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
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

      {tab === 'Servers' && <ServersTab />}
      {tab === 'Schedule' && <ScheduleTab />}
      {tab === 'Notifications' && <NotificationsTab />}
      {tab === 'Account' && <AccountTab />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Servers tab
// ---------------------------------------------------------------------------
function ServersTab() {
  const [serverList, setServerList] = useState<Server[]>([])
  const [groupList, setGroupList] = useState<ServerGroup[]>([])
  const [showAddServer, setShowAddServer] = useState(false)
  const [showAddGroup, setShowAddGroup] = useState(false)
  const [form, setForm] = useState({ name: '', hostname: '', username: '', ssh_port: '22', group_id: '' })
  const [groupForm, setGroupForm] = useState({ name: '', color: '#3b82f6' })
  const [formError, setFormError] = useState('')
  const [testing, setTesting] = useState<number | null>(null)
  const [testResults, setTestResults] = useState<Record<number, { success: boolean; detail: string }>>({})

  const load = useCallback(async () => {
    const [s, g] = await Promise.all([serversApi.list(), groupsApi.list()])
    setServerList(s)
    setGroupList(g)
  }, [])

  useEffect(() => { load() }, [load])

  async function handleAddServer(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    try {
      await serversApi.create({
        name: form.name,
        hostname: form.hostname,
        username: form.username,
        ssh_port: parseInt(form.ssh_port) || 22,
        group_id: form.group_id ? parseInt(form.group_id) : undefined,
      })
      setForm({ name: '', hostname: '', username: '', ssh_port: '22', group_id: '' })
      setShowAddServer(false)
      load()
    } catch (err: unknown) {
      setFormError((err as Error).message)
    }
  }

  async function handleAddGroup(e: React.FormEvent) {
    e.preventDefault()
    try {
      await groupsApi.create(groupForm)
      setGroupForm({ name: '', color: '#3b82f6' })
      setShowAddGroup(false)
      load()
    } catch (err: unknown) {
      setFormError((err as Error).message)
    }
  }

  async function handleTestConnection(id: number) {
    setTesting(id)
    try {
      const result = await serversApi.test(id)
      setTestResults(r => ({ ...r, [id]: result }))
    } finally {
      setTesting(null)
    }
  }

  async function handleDeleteServer(id: number) {
    if (!confirm('Delete this server and all its history?')) return
    await serversApi.remove(id)
    load()
  }

  async function handleDeleteGroup(id: number) {
    if (!confirm('Delete this group? Servers will be unassigned.')) return
    await groupsApi.remove(id)
    load()
  }

  async function handleToggleEnabled(server: Server) {
    await serversApi.update(server.id, { is_enabled: !server.is_enabled })
    load()
  }

  return (
    <div className="space-y-8">
      {/* Groups */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-text-muted uppercase tracking-wide">Server Groups</h2>
          <button className="btn-secondary text-xs" onClick={() => setShowAddGroup(!showAddGroup)}>+ Add Group</button>
        </div>

        {showAddGroup && (
          <form onSubmit={handleAddGroup} className="card p-4 mb-3 flex gap-3 items-end flex-wrap">
            <div>
              <label className="label">Name</label>
              <input className="input w-40" value={groupForm.name} onChange={e => setGroupForm(g => ({ ...g, name: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Color</label>
              <input type="color" className="h-9 w-16 rounded border border-border bg-surface-2 cursor-pointer" value={groupForm.color} onChange={e => setGroupForm(g => ({ ...g, color: e.target.value }))} />
            </div>
            <button type="submit" className="btn-primary">Save</button>
            <button type="button" className="btn-secondary" onClick={() => setShowAddGroup(false)}>Cancel</button>
          </form>
        )}

        <div className="flex flex-wrap gap-2">
          {groupList.map(g => (
            <div key={g.id} className="card px-3 py-2 flex items-center gap-2 text-sm">
              <span className="w-3 h-3 rounded-full" style={{ background: g.color || '#6b7280' }} />
              <span className="font-mono">{g.name}</span>
              <span className="text-text-muted text-xs">{g.server_count} servers</span>
              <button onClick={() => handleDeleteGroup(g.id)} className="text-text-muted hover:text-red text-xs ml-1">✕</button>
            </div>
          ))}
          {groupList.length === 0 && <p className="text-text-muted text-sm">No groups yet.</p>}
        </div>
      </section>

      {/* Servers */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-text-muted uppercase tracking-wide">Servers</h2>
          <button className="btn-secondary text-xs" onClick={() => setShowAddServer(!showAddServer)}>+ Add Server</button>
        </div>

        {showAddServer && (
          <form onSubmit={handleAddServer} className="card p-4 mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="label">Display Name</label>
              <input className="input" placeholder="my-server" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Hostname / IP</label>
              <input className="input" placeholder="192.168.1.10" value={form.hostname} onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))} required />
            </div>
            <div>
              <label className="label">SSH User</label>
              <input className="input" placeholder="ubuntu" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Port</label>
              <input className="input" type="number" value={form.ssh_port} onChange={e => setForm(f => ({ ...f, ssh_port: e.target.value }))} />
            </div>
            <div>
              <label className="label">Group</label>
              <select className="input" value={form.group_id} onChange={e => setForm(f => ({ ...f, group_id: e.target.value }))}>
                <option value="">None</option>
                {groupList.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            {formError && <p className="col-span-full text-red text-sm">{formError}</p>}
            <div className="col-span-full flex gap-2">
              <button type="submit" className="btn-primary">Add Server</button>
              <button type="button" className="btn-secondary" onClick={() => setShowAddServer(false)}>Cancel</button>
            </div>
          </form>
        )}

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-muted text-xs uppercase">
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">Hostname</th>
                <th className="text-left px-3 py-2">User</th>
                <th className="text-left px-3 py-2">Group</th>
                <th className="text-left px-3 py-2">Enabled</th>
                <th className="text-left px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {serverList.map((s, i) => (
                <tr key={s.id} className={`border-b border-border/50 ${i % 2 === 0 ? '' : 'bg-surface-2/30'}`}>
                  <td className="px-3 py-2 font-mono">{s.name}</td>
                  <td className="px-3 py-2 font-mono text-text-muted">{s.hostname}:{s.ssh_port}</td>
                  <td className="px-3 py-2 font-mono text-text-muted">{s.username}</td>
                  <td className="px-3 py-2">
                    {s.group_name ? (
                      <span className="badge text-xs" style={{ background: (s.group_color || '#3b82f6') + '22', color: s.group_color || '#3b82f6', border: `1px solid ${s.group_color || '#3b82f6'}44` }}>
                        {s.group_name}
                      </span>
                    ) : <span className="text-text-muted text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => handleToggleEnabled(s)}
                      className={`text-xs font-mono ${s.is_enabled ? 'text-green' : 'text-text-muted'}`}
                    >
                      {s.is_enabled ? 'yes' : 'no'}
                    </button>
                  </td>
                  <td className="px-3 py-2 flex gap-2">
                    <button
                      onClick={() => handleTestConnection(s.id)}
                      disabled={testing === s.id}
                      className="btn-secondary text-xs py-0.5"
                    >
                      {testing === s.id ? '…' : 'Test'}
                    </button>
                    {testResults[s.id] && (
                      <span className={`text-xs self-center ${testResults[s.id].success ? 'text-green' : 'text-red'}`}>
                        {testResults[s.id].success ? '✓' : '✗'}
                      </span>
                    )}
                    <button onClick={() => handleDeleteServer(s.id)} className="btn-danger text-xs py-0.5">Delete</button>
                  </td>
                </tr>
              ))}
              {serverList.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-text-muted">No servers added yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schedule tab
// ---------------------------------------------------------------------------
const CRON_PRESETS = [
  { label: 'Daily at 6 AM', value: '0 6 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Weekly Mon 6 AM', value: '0 6 * * 1' },
]

function ScheduleTab() {
  const [cfg, setCfg] = useState<ScheduleConfig | null>(null)
  const [form, setForm] = useState<Partial<ScheduleConfig>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    schedulerApi.status().then(c => { setCfg(c); setForm(c) })
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const updated = await schedulerApi.update(form)
    setCfg(updated)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!cfg) return <p className="text-text-muted text-sm">Loading…</p>

  return (
    <form onSubmit={handleSave} className="space-y-6 max-w-xl">
      <section className="card p-4 space-y-4">
        <h2 className="text-sm font-medium text-text-primary">Update Check Schedule</h2>
        <div className="flex items-center gap-3">
          <label className="text-sm text-text-muted">Enable scheduled checks</label>
          <input type="checkbox" checked={form.check_enabled ?? true} onChange={e => setForm(f => ({ ...f, check_enabled: e.target.checked }))} className="w-4 h-4 accent-green" />
        </div>
        <div>
          <label className="label">Cron expression</label>
          <input className="input mb-2" value={form.check_cron ?? ''} onChange={e => setForm(f => ({ ...f, check_cron: e.target.value }))} />
          <div className="flex flex-wrap gap-1">
            {CRON_PRESETS.map(p => (
              <button key={p.value} type="button" className="btn-secondary text-xs py-0.5" onClick={() => setForm(f => ({ ...f, check_cron: p.value }))}>{p.label}</button>
            ))}
          </div>
        </div>
        {cfg.next_check_time && (
          <p className="text-xs text-text-muted">Next run: <span className="font-mono text-cyan">{new Date(cfg.next_check_time).toLocaleString()}</span></p>
        )}
        <p className="text-xs text-text-muted">Timezone: <span className="font-mono">{cfg.timezone}</span></p>
      </section>

      <section className="card p-4 space-y-4">
        <h2 className="text-sm font-medium text-text-primary">Auto-Upgrade</h2>
        <div className="px-3 py-2 bg-amber/10 border border-amber/30 rounded text-amber text-xs">
          ⚠️ Auto-upgrade will automatically install package updates without review. Use with care.
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm text-text-muted">Enable auto-upgrade</label>
          <input type="checkbox" checked={form.auto_upgrade_enabled ?? false} onChange={e => setForm(f => ({ ...f, auto_upgrade_enabled: e.target.checked }))} className="w-4 h-4 accent-amber" />
        </div>
        {form.auto_upgrade_enabled && (
          <>
            <div>
              <label className="label">Auto-upgrade cron</label>
              <input className="input" value={form.auto_upgrade_cron ?? ''} onChange={e => setForm(f => ({ ...f, auto_upgrade_cron: e.target.value }))} />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm text-text-muted">Allow phased updates in auto-upgrade</label>
              <input type="checkbox" checked={form.allow_phased_on_auto ?? false} onChange={e => setForm(f => ({ ...f, allow_phased_on_auto: e.target.checked }))} className="w-4 h-4 accent-amber" />
            </div>
          </>
        )}
      </section>

      <section className="card p-4 space-y-4">
        <h2 className="text-sm font-medium text-text-primary">Concurrency & Retention</h2>
        <div>
          <label className="label">Max simultaneous upgrades</label>
          <input type="number" className="input w-24" min={1} max={20} value={form.upgrade_concurrency ?? 5} onChange={e => setForm(f => ({ ...f, upgrade_concurrency: parseInt(e.target.value) }))} />
        </div>
        <div>
          <label className="label">Log retention (days, 0 = forever)</label>
          <input type="number" className="input w-24" min={0} value={form.log_retention_days ?? 90} onChange={e => setForm(f => ({ ...f, log_retention_days: parseInt(e.target.value) }))} />
        </div>
      </section>

      <button type="submit" className="btn-primary">{saved ? '✓ Saved' : 'Save Schedule'}</button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Notifications tab
// ---------------------------------------------------------------------------
function NotificationsTab() {
  const [cfg, setCfg] = useState<NotificationConfig | null>(null)
  const [form, setForm] = useState<Partial<NotificationConfig>>({})
  const [saved, setSaved] = useState(false)
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})
  const [chatIds, setChatIds] = useState<{ id: number; title: string }[]>([])

  useEffect(() => {
    notifApi.getConfig().then(c => { setCfg(c); setForm(c) })
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const updated = await notifApi.updateConfig(form)
    setCfg(updated)
    setForm(updated)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function sendTestEmail() {
    try {
      await notifApi.testEmail()
      setTestMsg(m => ({ ...m, email: '✓ Test email sent' }))
    } catch (err: unknown) {
      setTestMsg(m => ({ ...m, email: `✗ ${(err as Error).message}` }))
    }
  }

  async function sendTestTelegram() {
    try {
      await notifApi.testTelegram()
      setTestMsg(m => ({ ...m, telegram: '✓ Test message sent' }))
    } catch (err: unknown) {
      setTestMsg(m => ({ ...m, telegram: `✗ ${(err as Error).message}` }))
    }
  }

  async function detectChatId() {
    try {
      const result = await notifApi.detectChatId()
      setChatIds(result.chats)
    } catch (err: unknown) {
      setTestMsg(m => ({ ...m, telegram: `✗ ${(err as Error).message}` }))
    }
  }

  if (!cfg) return <p className="text-text-muted text-sm">Loading…</p>

  return (
    <form onSubmit={handleSave} className="space-y-6 max-w-xl">
      {/* Email */}
      <section className="card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-primary">Email (SMTP)</h2>
          <input type="checkbox" checked={form.email_enabled ?? false} onChange={e => setForm(f => ({ ...f, email_enabled: e.target.checked }))} className="w-4 h-4 accent-green" />
        </div>
        {form.email_enabled && (
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">SMTP Host</label><input className="input" value={form.smtp_host ?? ''} onChange={e => setForm(f => ({ ...f, smtp_host: e.target.value }))} /></div>
            <div><label className="label">Port</label><input type="number" className="input" value={form.smtp_port ?? 587} onChange={e => setForm(f => ({ ...f, smtp_port: parseInt(e.target.value) }))} /></div>
            <div><label className="label">Username</label><input className="input" value={form.smtp_username ?? ''} onChange={e => setForm(f => ({ ...f, smtp_username: e.target.value }))} /></div>
            <div><label className="label">Password</label><input type="password" className="input" value={form.smtp_password ?? ''} onChange={e => setForm(f => ({ ...f, smtp_password: e.target.value }))} placeholder="unchanged" /></div>
            <div><label className="label">From</label><input className="input" value={form.email_from ?? ''} onChange={e => setForm(f => ({ ...f, email_from: e.target.value }))} /></div>
            <div><label className="label">To (comma-separated)</label><input className="input" value={form.email_to ?? ''} onChange={e => setForm(f => ({ ...f, email_to: e.target.value }))} /></div>
            <div className="flex items-center gap-2 col-span-full">
              <input type="checkbox" checked={form.smtp_use_tls ?? true} onChange={e => setForm(f => ({ ...f, smtp_use_tls: e.target.checked }))} className="w-4 h-4 accent-green" />
              <label className="text-sm text-text-muted">Use STARTTLS</label>
            </div>
            <div className="col-span-full flex items-center gap-3">
              <button type="button" onClick={sendTestEmail} className="btn-secondary text-xs">Send Test Email</button>
              {testMsg.email && <span className={`text-xs ${testMsg.email.startsWith('✓') ? 'text-green' : 'text-red'}`}>{testMsg.email}</span>}
            </div>
          </div>
        )}
      </section>

      {/* Telegram */}
      <section className="card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-primary">Telegram</h2>
          <input type="checkbox" checked={form.telegram_enabled ?? false} onChange={e => setForm(f => ({ ...f, telegram_enabled: e.target.checked }))} className="w-4 h-4 accent-green" />
        </div>
        {form.telegram_enabled && (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">Create a bot via <span className="font-mono text-cyan">@BotFather</span>, send it a message, then use "Detect Chat ID" to find your chat.</p>
            <div><label className="label">Bot Token</label><input type="password" className="input" value={form.telegram_bot_token ?? ''} onChange={e => setForm(f => ({ ...f, telegram_bot_token: e.target.value }))} placeholder="unchanged" /></div>
            <div><label className="label">Chat ID</label><input className="input" value={form.telegram_chat_id ?? ''} onChange={e => setForm(f => ({ ...f, telegram_chat_id: e.target.value }))} /></div>
            <div className="flex items-center gap-3 flex-wrap">
              <button type="button" onClick={detectChatId} className="btn-secondary text-xs">Detect Chat ID</button>
              <button type="button" onClick={sendTestTelegram} className="btn-secondary text-xs">Send Test Message</button>
              {testMsg.telegram && <span className={`text-xs ${testMsg.telegram.startsWith('✓') ? 'text-green' : 'text-red'}`}>{testMsg.telegram}</span>}
            </div>
            {chatIds.length > 0 && (
              <div className="space-y-1">
                {chatIds.map(c => (
                  <button key={c.id} type="button" onClick={() => setForm(f => ({ ...f, telegram_chat_id: String(c.id) }))} className="block text-xs font-mono text-cyan hover:text-text-primary">
                    {c.title}: {c.id}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Triggers */}
      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Notification Triggers</h2>
        {[
          { key: 'daily_summary_enabled', label: 'Daily summary after scheduled check' },
          { key: 'notify_on_upgrade_complete', label: 'Notify on upgrade complete' },
          { key: 'notify_on_error', label: 'Notify on server errors' },
        ].map(({ key, label }) => (
          <div key={key} className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={(form as Record<string, unknown>)[key] as boolean ?? true}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))}
              className="w-4 h-4 accent-green"
            />
            <label className="text-sm text-text-muted">{label}</label>
          </div>
        ))}
        <div>
          <label className="label">Daily summary time (24h)</label>
          <input type="time" className="input w-32" value={form.daily_summary_time ?? '07:00'} onChange={e => setForm(f => ({ ...f, daily_summary_time: e.target.value }))} />
        </div>
      </section>

      <button type="submit" className="btn-primary">{saved ? '✓ Saved' : 'Save Notifications'}</button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Account tab
// ---------------------------------------------------------------------------
function AccountTab() {
  const { user, logout } = useAuthStore()
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' })
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setMsg('')
    setError('')
    if (form.new_password !== form.confirm) {
      setError('New passwords do not match')
      return
    }
    try {
      await auth.changePassword(form.current_password, form.new_password)
      setMsg('Password changed successfully')
      setForm({ current_password: '', new_password: '', confirm: '' })
    } catch (err: unknown) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="max-w-sm space-y-6">
      <div className="card p-4 space-y-2">
        <p className="text-sm text-text-muted">Username: <span className="font-mono text-text-primary">{user?.username}</span></p>
        <p className="text-sm text-text-muted">Last login: <span className="font-mono text-text-primary">{user?.last_login ? new Date(user.last_login).toLocaleString() : '—'}</span></p>
      </div>

      <div className="card p-4">
        <h2 className="text-sm font-medium text-text-primary mb-4">Change Password</h2>
        <form onSubmit={handleChangePassword} className="space-y-3">
          <div><label className="label">Current Password</label><input type="password" className="input" value={form.current_password} onChange={e => setForm(f => ({ ...f, current_password: e.target.value }))} /></div>
          <div><label className="label">New Password</label><input type="password" className="input" value={form.new_password} onChange={e => setForm(f => ({ ...f, new_password: e.target.value }))} /></div>
          <div><label className="label">Confirm New Password</label><input type="password" className="input" value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} /></div>
          {error && <p className="text-red text-sm">{error}</p>}
          {msg && <p className="text-green text-sm">{msg}</p>}
          <button type="submit" className="btn-primary">Change Password</button>
        </form>
      </div>

      <button onClick={logout} className="btn-danger w-full">Logout</button>
    </div>
  )
}
