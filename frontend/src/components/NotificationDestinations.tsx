import { useEffect, useState } from 'react'
import { notifications as notifApi, type NotificationDestination } from '@/api/client'
import { toast } from '@/hooks/useToast'
import { confirmDialog } from '@/hooks/useConfirm'

const TYPES = ['discord', 'mattermost', 'ntfy', 'webhook', 'pagerduty', 'opsgenie'] as const

const URL_HINT: Record<string, string> = {
  discord: 'Discord webhook URL',
  mattermost: 'Mattermost incoming-webhook URL',
  ntfy: 'ntfy topic URL (e.g. https://ntfy.sh/my-topic)',
  webhook: 'Generic webhook URL (JSON POST)',
  pagerduty: 'PagerDuty Events API v2 routing key',
  opsgenie: 'Opsgenie API key',
}

// Extra on-call / chat notification targets (issue #62).
export default function NotificationDestinations() {
  const [items, setItems] = useState<NotificationDestination[]>([])
  const [form, setForm] = useState({ name: '', type: 'discord', url: '', events: '' })
  const [saving, setSaving] = useState(false)

  const load = () => { notifApi.listDestinations().then(setItems).catch(() => {}) }
  useEffect(() => { load() }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.url.trim()) return
    setSaving(true)
    try {
      await notifApi.createDestination({ ...form, events: form.events.trim() || undefined } as Partial<NotificationDestination>)
      setForm({ name: '', type: 'discord', url: '', events: '' })
      load()
      toast.success('Destination added')
    } catch (err) { toast.error((err as Error).message) }
    finally { setSaving(false) }
  }

  async function remove(d: NotificationDestination) {
    if (!await confirmDialog({ message: `Delete destination "${d.name}"?`, confirmLabel: 'Delete', danger: true })) return
    try { await notifApi.deleteDestination(d.id); load() } catch (err) { toast.error((err as Error).message) }
  }

  async function toggle(d: NotificationDestination) {
    try { await notifApi.updateDestination(d.id, { enabled: !d.enabled }); load() } catch (err) { toast.error((err as Error).message) }
  }

  async function test(d: NotificationDestination) {
    try { await notifApi.testDestination(d.id); toast.success(`Test sent to ${d.name}`) }
    catch (err) { toast.error((err as Error).message) }
  }

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-medium text-text-primary">On-call &amp; chat destinations</h2>
        <p className="text-xs text-text-muted mt-0.5">
          Extra targets that receive security / reboot / lockout / digest events. Leave “events” blank to receive all.
        </p>
      </div>

      {items.length > 0 && (
        <div className="space-y-1">
          {items.map(d => (
            <div key={d.id} className="flex items-center gap-2 text-xs font-mono border border-border/50 rounded px-2 py-1.5">
              <input type="checkbox" checked={d.enabled} onChange={() => toggle(d)} className="w-3.5 h-3.5 accent-green" title="Enabled" />
              <span className="badge bg-surface-2 text-text-muted border border-border">{d.type}</span>
              <span className="text-text-primary">{d.name}</span>
              <span className="text-text-muted truncate flex-1">{d.events || 'all events'}</span>
              <button onClick={() => test(d)} className="btn-secondary text-xs py-0.5">Test</button>
              <button onClick={() => remove(d)} className="text-text-muted hover:text-red">✕</button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div>
          <label className="label">Name</label>
          <input className="input text-sm w-32" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input text-sm w-32" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-48">
          <label className="label">{URL_HINT[form.type]}</label>
          <input className="input text-sm w-full" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
        </div>
        <div>
          <label className="label">Events (CSV, optional)</label>
          <input className="input text-sm w-40" placeholder="security,reboot_required" value={form.events} onChange={e => setForm(f => ({ ...f, events: e.target.value }))} />
        </div>
        <button type="submit" disabled={saving} className="btn-primary text-sm">Add</button>
      </form>
    </section>
  )
}
