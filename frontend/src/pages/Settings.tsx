import { useState, useEffect, useCallback, useRef } from 'react'
import { servers as serversApi, groups as groupsApi, tags as tagsApi, scheduler as schedulerApi, notifications as notifApi, auth, config as configApi } from '@/api/client'
import type { Server, ServerGroup, ScheduleConfig, NotificationConfig, Tag } from '@/types'
import { useAuthStore } from '@/hooks/useAuth'

const TABS = ['Servers', 'Schedule', 'Preferences', 'Notifications', 'Account', 'Backup'] as const
type Tab = typeof TABS[number]

const PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a3e635',
  '#e879f9', '#fb7185', '#34d399', '#60a5fa', '#fbbf24',
]

function pickDistinctColor(existingColors: string[]): string {
  const used = new Set(existingColors.map(c => c.toLowerCase()))
  const candidate = PALETTE.find(c => !used.has(c))
  if (candidate) return candidate
  // All palette colors used — generate a random hue
  const hue = Math.floor(Math.random() * 360)
  return `hsl(${hue},70%,55%)`
}

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
      {tab === 'Preferences' && <PreferencesTab />}
      {tab === 'Notifications' && <NotificationsTab />}
      {tab === 'Account' && <AccountTab />}
      {tab === 'Backup' && <BackupTab />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Servers tab
// ---------------------------------------------------------------------------
function ServersTab() {
  const [serverList, setServerList] = useState<Server[]>([])
  const [groupList, setGroupList] = useState<ServerGroup[]>([])
  const [tagList, setTagList] = useState<Tag[]>([])
  const [showAddServer, setShowAddServer] = useState(false)
  const [showAddGroup, setShowAddGroup] = useState(false)
  const [showAddTag, setShowAddTag] = useState(false)
  const [form, setForm] = useState({ name: '', hostname: '', username: '', ssh_port: '22', groupIds: [] as number[], tagIds: [] as number[], ssh_private_key: '' })
  const [showAddSshKey, setShowAddSshKey] = useState(false)
  const [groupForm, setGroupForm] = useState({ name: '', color: '#3b82f6' })
  const [tagForm, setTagForm] = useState({ name: '', color: '#6366f1' })
  const [formError, setFormError] = useState('')
  const [testing, setTesting] = useState<number | null>(null)
  const [testResults, setTestResults] = useState<Record<number, { success: boolean; detail: string }>>({})
  // Inline editing state
  const [editingServer, setEditingServer] = useState<number | null>(null)
  const [editForm, setEditForm] = useState({
    name: '',
    hostname: '',
    username: '',
    ssh_port: '22',
    group_ids: [] as number[],
    is_enabled: true,
    tagIds: [] as number[],
    tagInput: '',
  })
  const [editTagDropdown, setEditTagDropdown] = useState(false)
  const [editError, setEditError] = useState('')
  const [showSshKeyInput, setShowSshKeyInput] = useState(false)
  const [editSshKey, setEditSshKey] = useState('')
  const [editingGroup, setEditingGroup] = useState<number | null>(null)
  const [editGroupForm, setEditGroupForm] = useState({ name: '', color: '#3b82f6' })
  const [editingTag, setEditingTag] = useState<number | null>(null)
  const [editTagForm, setEditTagForm] = useState({ name: '', color: '#6366f1' })
  const tagInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const [s, g, t] = await Promise.all([serversApi.list(), groupsApi.list(), tagsApi.list()])
    setServerList(s)
    setGroupList(g)
    setTagList(t)
  }, [])

  useEffect(() => { load() }, [load])

  function startEditServer(s: Server) {
    setEditingServer(s.id)
    setEditForm({
      name: s.name,
      hostname: s.hostname,
      username: s.username,
      ssh_port: String(s.ssh_port),
      group_ids: (s.groups ?? []).map(g => g.id),
      is_enabled: s.is_enabled,
      tagIds: (s.tags ?? []).map(t => t.id),
      tagInput: '',
    })
    setEditTagDropdown(false)
    setEditError('')
    setShowSshKeyInput(false)
    setEditSshKey('')
  }

  async function handleSaveServer() {
    if (!editingServer) return
    setEditError('')
    try {
      await serversApi.update(editingServer, {
        name: editForm.name,
        hostname: editForm.hostname,
        username: editForm.username,
        ssh_port: parseInt(editForm.ssh_port) || 22,
        group_id: editForm.group_ids[0] ?? null,
        group_ids: editForm.group_ids,
        is_enabled: editForm.is_enabled,
        tag_ids: editForm.tagIds,
      })
      setEditingServer(null)
      load()
    } catch (err: unknown) {
      setEditError((err as Error).message)
    }
  }

  async function handleSetSshKey(serverId: number) {
    if (!editSshKey.trim()) return
    setEditError('')
    try {
      await serversApi.update(serverId, { ssh_private_key: editSshKey.trim() })
      setShowSshKeyInput(false)
      setEditSshKey('')
      load()
    } catch (err: unknown) {
      setEditError((err as Error).message)
    }
  }

  async function handleClearSshKey(serverId: number) {
    setEditError('')
    try {
      await serversApi.clearSshKey(serverId)
      load()
    } catch (err: unknown) {
      setEditError((err as Error).message)
    }
  }

  function startEditGroup(g: ServerGroup) {
    setEditingGroup(g.id)
    setEditGroupForm({ name: g.name, color: g.color || '#3b82f6' })
  }

  async function handleSaveGroup() {
    if (!editingGroup) return
    try {
      await groupsApi.update(editingGroup, editGroupForm)
      setEditingGroup(null)
      load()
    } catch (err: unknown) {
      setFormError((err as Error).message)
    }
  }

  async function handleAddServer(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    try {
      await serversApi.create({
        name: form.name,
        hostname: form.hostname,
        username: form.username,
        ssh_port: parseInt(form.ssh_port) || 22,
        group_id: form.groupIds[0] ?? undefined,
        group_ids: form.groupIds,
        tag_ids: form.tagIds,
        ssh_private_key: form.ssh_private_key.trim() || undefined,
      })
      setForm({ name: '', hostname: '', username: '', ssh_port: '22', groupIds: [], tagIds: [], ssh_private_key: '' })
      setShowAddSshKey(false)
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
      const updated = await groupsApi.list()
      setGroupList(updated)
      setGroupForm({ name: '', color: pickDistinctColor(updated.map(g => g.color || '')) })
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

  async function handleAddTag(e: React.FormEvent) {
    e.preventDefault()
    try {
      await tagsApi.create(tagForm)
      setTagForm({ name: '', color: '#6366f1' })
      setShowAddTag(false)
      load()
    } catch (err: unknown) {
      setFormError((err as Error).message)
    }
  }

  async function handleSaveTag() {
    if (!editingTag) return
    try {
      await tagsApi.update(editingTag, editTagForm)
      setEditingTag(null)
      load()
    } catch (err: unknown) {
      setFormError((err as Error).message)
    }
  }

  async function handleDeleteTag(id: number) {
    if (!confirm('Delete this tag? It will be removed from all servers.')) return
    await tagsApi.remove(id)
    load()
  }

  // Tag autocomplete helpers
  function addTagToEdit(tag: Tag) {
    if (!editForm.tagIds.includes(tag.id)) {
      setEditForm(f => ({ ...f, tagIds: [...f.tagIds, tag.id], tagInput: '' }))
    }
    setEditTagDropdown(false)
  }

  function removeTagFromEdit(tagId: number) {
    setEditForm(f => ({ ...f, tagIds: f.tagIds.filter(id => id !== tagId) }))
  }

  function toggleGroupInEdit(groupId: number) {
    setEditForm(f => {
      const ids = f.group_ids.includes(groupId)
        ? f.group_ids.filter(id => id !== groupId)
        : [...f.group_ids, groupId]
      return { ...f, group_ids: ids }
    })
  }

  const filteredTagSuggestions = tagList.filter(t =>
    !editForm.tagIds.includes(t.id) &&
    t.name.toLowerCase().includes(editForm.tagInput.toLowerCase())
  )

  return (
    <div className="space-y-8">
      {/* Groups */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-text-muted uppercase tracking-wide">Server Groups</h2>
          <button className="btn-secondary text-xs" onClick={() => {
            if (!showAddGroup) {
              setGroupForm({ name: '', color: pickDistinctColor(groupList.map(g => g.color || '')) })
            }
            setShowAddGroup(!showAddGroup)
          }}>+ Add Group</button>
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
              {editingGroup === g.id ? (
                <>
                  <input
                    className="input w-32 text-xs py-1"
                    value={editGroupForm.name}
                    onChange={e => setEditGroupForm(f => ({ ...f, name: e.target.value }))}
                    autoFocus
                  />
                  <input
                    type="color"
                    className="h-7 w-10 rounded border border-border bg-surface-2 cursor-pointer"
                    value={editGroupForm.color}
                    onChange={e => setEditGroupForm(f => ({ ...f, color: e.target.value }))}
                  />
                  <button onClick={handleSaveGroup} className="btn-primary text-xs py-0.5">✓</button>
                  <button onClick={() => setEditingGroup(null)} className="btn-secondary text-xs py-0.5">✕</button>
                </>
              ) : (
                <>
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: g.color || '#6b7280' }} />
                  <span className="font-mono">{g.name}</span>
                  <span className="text-text-muted text-xs">{g.server_count} servers</span>
                  <button onClick={() => startEditGroup(g)} className="text-text-muted hover:text-text-primary text-xs">✎</button>
                  <button onClick={() => handleDeleteGroup(g.id)} className="text-text-muted hover:text-red text-xs">✕</button>
                </>
              )}
            </div>
          ))}
          {groupList.length === 0 && <p className="text-text-muted text-sm">No groups yet.</p>}
        </div>
        {formError && <p className="text-red text-xs mt-1">{formError}</p>}
      </section>

      {/* Tags */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-text-muted uppercase tracking-wide">Tags</h2>
          <button className="btn-secondary text-xs" onClick={() => setShowAddTag(!showAddTag)}>+ Add Tag</button>
        </div>

        {showAddTag && (
          <form onSubmit={handleAddTag} className="card p-4 mb-3 flex gap-3 items-end flex-wrap">
            <div>
              <label className="label">Name</label>
              <input className="input w-40" value={tagForm.name} onChange={e => setTagForm(t => ({ ...t, name: e.target.value }))} required autoFocus />
            </div>
            <div>
              <label className="label">Color</label>
              <input type="color" className="h-9 w-16 rounded border border-border bg-surface-2 cursor-pointer" value={tagForm.color} onChange={e => setTagForm(t => ({ ...t, color: e.target.value }))} />
            </div>
            <button type="submit" className="btn-primary">Save</button>
            <button type="button" className="btn-secondary" onClick={() => setShowAddTag(false)}>Cancel</button>
          </form>
        )}

        <div className="flex flex-wrap gap-2">
          {tagList.map(t => (
            <div key={t.id} className="card px-3 py-2 flex items-center gap-2 text-sm">
              {editingTag === t.id ? (
                <>
                  <input
                    className="input w-32 text-xs py-1"
                    value={editTagForm.name}
                    onChange={e => setEditTagForm(f => ({ ...f, name: e.target.value }))}
                    autoFocus
                  />
                  <input
                    type="color"
                    className="h-7 w-10 rounded border border-border bg-surface-2 cursor-pointer"
                    value={editTagForm.color}
                    onChange={e => setEditTagForm(f => ({ ...f, color: e.target.value }))}
                  />
                  <button onClick={handleSaveTag} className="btn-primary text-xs py-0.5">✓</button>
                  <button onClick={() => setEditingTag(null)} className="btn-secondary text-xs py-0.5">✕</button>
                </>
              ) : (
                <>
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: t.color || '#6366f1' }} />
                  <span className="font-mono">{t.name}</span>
                  <span className="text-text-muted text-xs">{t.server_count ?? 0} servers</span>
                  <button onClick={() => { setEditingTag(t.id); setEditTagForm({ name: t.name, color: t.color }) }} className="text-text-muted hover:text-text-primary text-xs">✎</button>
                  <button onClick={() => handleDeleteTag(t.id)} className="text-text-muted hover:text-red text-xs">✕</button>
                </>
              )}
            </div>
          ))}
          {tagList.length === 0 && <p className="text-text-muted text-sm">No tags yet.</p>}
        </div>
      </section>

      {/* Servers */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-text-muted uppercase tracking-wide">Servers</h2>
          <button className="btn-secondary text-xs" onClick={() => setShowAddServer(!showAddServer)}>+ Add Server</button>
        </div>

        {/* CSV strip */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <button
            className="btn-secondary text-xs"
            onClick={async () => {
              const res = await configApi.exportCsv()
              const blob = await res.blob()
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `apt-dashboard-servers-${new Date().toISOString().slice(0, 10)}.csv`
              a.click()
              URL.revokeObjectURL(url)
            }}
          >
            Export CSV
          </button>
          <label className="btn-secondary text-xs cursor-pointer">
            Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async e => {
                const file = e.target.files?.[0]
                if (!file) return
                try {
                  const result = await configApi.importCsv(file)
                  alert(`Imported: ${result.added} added, ${result.skipped} skipped`)
                  load()
                } catch (err: unknown) {
                  alert('Import failed: ' + (err instanceof Error ? err.message : String(err)))
                }
                e.target.value = ''
              }}
            />
          </label>
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
            <div className="col-span-full">
              <label className="label">Groups</label>
              <div className="flex flex-wrap gap-1.5">
                {groupList.map(g => {
                  const sel = form.groupIds.includes(g.id)
                  const c = g.color || '#3b82f6'
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => setForm(f => ({
                        ...f,
                        groupIds: sel ? f.groupIds.filter(id => id !== g.id) : [...f.groupIds, g.id]
                      }))}
                      className="px-2 py-0.5 rounded text-xs border transition-opacity"
                      style={{
                        background: sel ? c + '33' : 'transparent',
                        color: c,
                        borderColor: sel ? c + '88' : c + '44',
                        opacity: sel ? 1 : 0.6,
                      }}
                    >
                      {g.name}
                    </button>
                  )
                })}
                {groupList.length === 0 && <span className="text-xs text-text-muted">No groups yet — create them in the Groups section above</span>}
              </div>
            </div>
            <div className="col-span-full">
              <label className="label">Tags</label>
              <div className="flex flex-wrap gap-1.5">
                {tagList.map(t => {
                  const sel = form.tagIds.includes(t.id)
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setForm(f => ({
                        ...f,
                        tagIds: sel ? f.tagIds.filter(id => id !== t.id) : [...f.tagIds, t.id]
                      }))}
                      className="px-2 py-0.5 rounded text-xs border transition-opacity"
                      style={{
                        background: sel ? t.color + '33' : 'transparent',
                        color: t.color,
                        borderColor: sel ? t.color + '88' : t.color + '44',
                        opacity: sel ? 1 : 0.6,
                      }}
                    >
                      {t.name}
                    </button>
                  )
                })}
                {tagList.length === 0 && <span className="text-xs text-text-muted">No tags yet — create them in the Tags section above</span>}
              </div>
            </div>
            <div className="col-span-full">
              <button type="button" className="text-xs text-text-muted hover:text-text-primary" onClick={() => setShowAddSshKey(v => !v)}>
                {showAddSshKey ? '▾' : '▸'} Per-server SSH key <span className="opacity-60">(optional — overrides global key)</span>
              </button>
              {showAddSshKey && (
                <div className="mt-2 space-y-1">
                  <textarea
                    className="input w-full font-mono text-xs h-28 resize-y"
                    placeholder="-----BEGIN ... PRIVATE KEY-----&#10;...&#10;-----END ... PRIVATE KEY-----"
                    value={form.ssh_private_key}
                    onChange={e => setForm(f => ({ ...f, ssh_private_key: e.target.value }))}
                  />
                  <p className="text-xs text-text-muted">Stored encrypted at rest. Leave empty to use the global <span className="font-mono">SSH_PRIVATE_KEY</span>.</p>
                </div>
              )}
            </div>
            {formError && <p className="col-span-full text-red text-sm">{formError}</p>}
            <div className="col-span-full flex gap-2">
              <button type="submit" className="btn-primary">Add Server</button>
              <button type="button" className="btn-secondary" onClick={() => setShowAddServer(false)}>Cancel</button>
            </div>
          </form>
        )}

        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-border text-text-muted text-xs uppercase">
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">Hostname</th>
                <th className="text-left px-3 py-2">User / Port</th>
                <th className="text-left px-3 py-2">Group</th>
                <th className="text-left px-3 py-2">Tags</th>
                <th className="text-left px-3 py-2">Enabled</th>
                <th className="text-left px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {serverList.map((s, i) => editingServer === s.id ? (
                /* ── Inline edit row ── */
                <tr key={s.id} className="border-b border-border/50 bg-surface-2/50">
                  <td className="px-2 py-2">
                    <input className="input w-full text-xs py-1" value={editForm.name}
                      onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} autoFocus />
                  </td>
                  <td className="px-2 py-2">
                    <input className="input w-full text-xs py-1" value={editForm.hostname}
                      onChange={e => setEditForm(f => ({ ...f, hostname: e.target.value }))} />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1">
                      <input className="input w-24 text-xs py-1" value={editForm.username}
                        onChange={e => setEditForm(f => ({ ...f, username: e.target.value }))} placeholder="user" />
                      <input className="input w-16 text-xs py-1" type="number" value={editForm.ssh_port}
                        onChange={e => setEditForm(f => ({ ...f, ssh_port: e.target.value }))} placeholder="22" />
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    {/* Multi-group checkboxes */}
                    <div className="space-y-1 max-h-24 overflow-y-auto">
                      {groupList.map(g => (
                        <label key={g.id} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            className="w-3 h-3 accent-green"
                            checked={editForm.group_ids.includes(g.id)}
                            onChange={() => toggleGroupInEdit(g.id)}
                          />
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color || '#3b82f6' }} />
                          <span className="text-xs text-text-primary truncate">{g.name}</span>
                        </label>
                      ))}
                      {groupList.length === 0 && <span className="text-text-muted text-xs">No groups</span>}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    {/* Tag autocomplete */}
                    <div className="relative">
                      <div className="flex flex-wrap gap-1 mb-1">
                        {editForm.tagIds.map(tid => {
                          const t = tagList.find(x => x.id === tid)
                          if (!t) return null
                          return (
                            <span
                              key={tid}
                              className="badge text-xs cursor-pointer"
                              style={{ background: t.color + '22', color: t.color, border: `1px solid ${t.color}44` }}
                              onClick={() => removeTagFromEdit(tid)}
                            >
                              {t.name} ×
                            </span>
                          )
                        })}
                      </div>
                      <input
                        ref={tagInputRef}
                        className="input w-full text-xs py-1"
                        placeholder="Add tag…"
                        value={editForm.tagInput}
                        onChange={e => { setEditForm(f => ({ ...f, tagInput: e.target.value })); setEditTagDropdown(true) }}
                        onFocus={() => setEditTagDropdown(true)}
                        onBlur={() => setTimeout(() => setEditTagDropdown(false), 150)}
                      />
                      {editTagDropdown && editForm.tagInput && filteredTagSuggestions.length > 0 && (
                        <div className="absolute z-20 left-0 top-full mt-1 bg-surface border border-border rounded shadow-lg w-full max-h-32 overflow-y-auto">
                          {filteredTagSuggestions.map(t => (
                            <button
                              key={t.id}
                              type="button"
                              className="w-full text-left px-2 py-1 text-xs hover:bg-surface-2 flex items-center gap-1.5"
                              onMouseDown={() => addTagToEdit(t)}
                            >
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
                              {t.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <input type="checkbox" checked={editForm.is_enabled}
                      onChange={e => setEditForm(f => ({ ...f, is_enabled: e.target.checked }))}
                      className="w-4 h-4 accent-green" />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-col gap-1">
                      <div className="flex gap-1">
                        <button onClick={handleSaveServer} className="btn-primary text-xs py-0.5">Save</button>
                        <button onClick={() => setEditingServer(null)} className="btn-secondary text-xs py-0.5">Cancel</button>
                      </div>
                      {/* Per-server SSH key management */}
                      {!showSshKeyInput ? (
                        <div className="flex items-center gap-2 flex-wrap">
                          {s.ssh_key_configured && (
                            <span className="text-xs text-green font-mono">🔑 key set</span>
                          )}
                          <button type="button" className="text-xs text-text-muted hover:text-text-primary" onClick={() => setShowSshKeyInput(true)}>
                            {s.ssh_key_configured ? 'replace' : '+ set key'}
                          </button>
                          {s.ssh_key_configured && (
                            <button type="button" className="text-xs text-text-muted hover:text-red" onClick={() => handleClearSshKey(s.id)}>clear</button>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-1 pt-1">
                          <textarea
                            className="input w-full font-mono text-xs py-1 h-20 resize-y"
                            placeholder="-----BEGIN ... PRIVATE KEY-----"
                            value={editSshKey}
                            onChange={e => setEditSshKey(e.target.value)}
                            autoFocus
                          />
                          <div className="flex gap-1">
                            <button type="button" className="btn-primary text-xs py-0.5" onClick={() => handleSetSshKey(s.id)}>Set Key</button>
                            <button type="button" className="btn-secondary text-xs py-0.5" onClick={() => { setShowSshKeyInput(false); setEditSshKey('') }}>Cancel</button>
                          </div>
                        </div>
                      )}
                      {editError && <span className="text-red text-xs">{editError}</span>}
                    </div>
                  </td>
                </tr>
              ) : (
                /* ── Normal display row ── */
                <tr key={s.id} className={`border-b border-border/50 ${i % 2 === 0 ? '' : 'bg-surface-2/30'}`}>
                  <td className="px-3 py-2 font-mono">{s.name}</td>
                  <td className="px-3 py-2 font-mono text-text-muted">{s.hostname}</td>
                  <td className="px-3 py-2 font-mono text-text-muted text-xs">
                    <div>{s.username} :{s.ssh_port}</div>
                    {s.ssh_key_configured && <span className="text-xs text-green" title="Per-server SSH key configured">🔑</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(s.groups ?? []).length > 0
                        ? (s.groups ?? []).map(g => (
                            <span key={g.id} className="badge text-xs" style={{ background: (g.color || '#3b82f6') + '22', color: g.color || '#3b82f6', border: `1px solid ${g.color || '#3b82f6'}44` }}>
                              {g.name}
                            </span>
                          ))
                        : <span className="text-text-muted text-xs">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(s.tags ?? []).length > 0
                        ? (s.tags ?? []).map(t => (
                            <span key={t.id} className="badge text-xs" style={{ background: (t.color || '#6366f1') + '22', color: t.color || '#6366f1', border: `1px solid ${t.color || '#6366f1'}44` }}>
                              {t.name}
                            </span>
                          ))
                        : <span className="text-text-muted text-xs">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-xs font-mono ${s.is_enabled ? 'text-green' : 'text-text-muted'}`}>
                      {s.is_enabled ? 'yes' : 'no'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 flex-wrap">
                      <button onClick={() => startEditServer(s)} className="btn-secondary text-xs py-0.5">Edit</button>
                      <button
                        onClick={() => handleTestConnection(s.id)}
                        disabled={testing === s.id}
                        className="btn-secondary text-xs py-0.5"
                      >
                        {testing === s.id ? '…' : testResults[s.id] ? (testResults[s.id].success ? '✓ OK' : '✗ Fail') : 'Test'}
                      </button>
                      <button onClick={() => handleDeleteServer(s.id)} className="btn-danger text-xs py-0.5">Del</button>
                    </div>
                  </td>
                </tr>
              ))}
              {serverList.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-text-muted">No servers added yet.</td></tr>
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

      <button type="submit" className="btn-primary">{saved ? '✓ Saved' : 'Save Schedule'}</button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Preferences tab — auto-upgrade, concurrency, retention, auto-tagging
// ---------------------------------------------------------------------------
function PreferencesTab() {
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
        <h2 className="text-sm font-medium text-text-primary">Auto-Upgrade</h2>
        <div className="px-3 py-2 bg-amber/10 border border-amber/30 rounded text-amber text-xs">
          ⚠️ Auto-upgrade will automatically install package updates without review. Use with care.
        </div>
        <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
          <input type="checkbox" checked={form.auto_upgrade_enabled ?? false} onChange={e => setForm(f => ({ ...f, auto_upgrade_enabled: e.target.checked }))} className="w-4 h-4 accent-amber" />
          Enable auto-upgrade after scheduled check
        </label>
        {form.auto_upgrade_enabled && (
          <div className="pl-6 space-y-3">
            <div>
              <label className="label">Auto-upgrade cron</label>
              <input className="input" value={form.auto_upgrade_cron ?? ''} onChange={e => setForm(f => ({ ...f, auto_upgrade_cron: e.target.value }))} />
            </div>
            <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
              <input type="checkbox" checked={form.allow_phased_on_auto ?? false} onChange={e => setForm(f => ({ ...f, allow_phased_on_auto: e.target.checked }))} className="w-4 h-4 accent-amber" />
              Allow phased updates in auto-upgrade
            </label>
            {cfg.next_upgrade_time && (
              <p className="text-xs text-text-muted">Next auto-upgrade: <span className="font-mono text-cyan">{new Date(cfg.next_upgrade_time).toLocaleString()}</span></p>
            )}
          </div>
        )}
      </section>

      <section className="card p-4 space-y-4">
        <h2 className="text-sm font-medium text-text-primary">Concurrency & Retention</h2>
        <div>
          <label className="label">Max simultaneous upgrades</label>
          <input type="number" className="input w-24" min={1} max={20} value={form.upgrade_concurrency ?? 5} onChange={e => setForm(f => ({ ...f, upgrade_concurrency: parseInt(e.target.value) }))} />
          <p className="text-xs text-text-muted mt-1">Applies to both manual "Upgrade All" and auto-upgrades.</p>
        </div>
        <div>
          <label className="label">Log retention (days, 0 = forever)</label>
          <input type="number" className="input w-24" min={0} value={form.log_retention_days ?? 90} onChange={e => setForm(f => ({ ...f, log_retention_days: parseInt(e.target.value) }))} />
          <p className="text-xs text-text-muted mt-1">Check history and upgrade logs older than this are purged nightly.</p>
        </div>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Auto-Tagging</h2>
        <p className="text-xs text-text-muted">Automatically create and assign tags to servers based on check results. Runs on every "Check All".</p>
        <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-green" checked={form.auto_tag_os ?? false} onChange={e => setForm(f => ({ ...f, auto_tag_os: e.target.checked }))} />
          Auto-tag by OS <span className="text-xs font-mono text-text-muted/60">(e.g. "Ubuntu 22.04", "Debian 12")</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-green" checked={form.auto_tag_virt ?? false} onChange={e => setForm(f => ({ ...f, auto_tag_virt: e.target.checked }))} />
          Auto-tag by machine type <span className="text-xs font-mono text-text-muted/60">(e.g. "bare-metal", "vm (kvm)", "container (lxc)")</span>
        </label>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Upgrade Behaviour</h2>
        <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-amber" checked={form.run_apt_update_before_upgrade ?? false} onChange={e => setForm(f => ({ ...f, run_apt_update_before_upgrade: e.target.checked }))} />
          Run <span className="font-mono text-text-primary">apt-get update</span> before upgrading
        </label>
        <p className="text-xs text-text-muted pl-6">
          When disabled (default), upgrades only install packages already known from the last "Check". Enabling this fetches the latest package index first, which may pull in updates not yet visible on the dashboard.
        </p>
        <div className="space-y-1">
          <label className="text-sm text-text-muted">Config file handling</label>
          <select
            className="input w-full"
            value={form.conffile_action ?? 'confdef_confold'}
            onChange={e => setForm(f => ({ ...f, conffile_action: e.target.value }))}
          >
            <option value="confdef_confold">Keep existing (safe default — use package default, fall back to keep old)</option>
            <option value="confold">Always keep existing config files</option>
            <option value="confnew">Always take new config files from package</option>
          </select>
          <p className="text-xs text-text-muted">
            Controls what happens when a package ships a new version of a config file you have modified (e.g. <span className="font-mono">/etc/motd</span>, <span className="font-mono">/etc/ssh/sshd_config</span>). The safe default keeps your existing file.
          </p>
        </div>
      </section>

      <button type="submit" className="btn-primary">{saved ? '✓ Saved' : 'Save Preferences'}</button>
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
      <section className="card p-4 space-y-4">
        <h2 className="text-sm font-medium text-text-primary">Notification Triggers</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-muted text-xs">
                <th className="text-left py-1 pr-4">Trigger</th>
                <th className="text-center py-1 px-3">Enabled</th>
                <th className="text-center py-1 px-3">Email</th>
                <th className="text-center py-1 px-3">Telegram</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {/* Daily summary */}
              <tr>
                <td className="py-2 pr-4 text-text-primary">Daily summary</td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.daily_summary_enabled ?? true}
                    onChange={e => setForm(f => ({ ...f, daily_summary_enabled: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.daily_summary_email ?? true}
                    onChange={e => setForm(f => ({ ...f, daily_summary_email: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.daily_summary_telegram ?? true}
                    onChange={e => setForm(f => ({ ...f, daily_summary_telegram: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
              </tr>
              {/* Upgrade complete */}
              <tr>
                <td className="py-2 pr-4 text-text-primary">Upgrade complete</td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_on_upgrade_complete ?? true}
                    onChange={e => setForm(f => ({ ...f, notify_on_upgrade_complete: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_upgrade_email ?? true}
                    onChange={e => setForm(f => ({ ...f, notify_upgrade_email: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_upgrade_telegram ?? true}
                    onChange={e => setForm(f => ({ ...f, notify_upgrade_telegram: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
              </tr>
              {/* On error */}
              <tr>
                <td className="py-2 pr-4 text-text-primary">On error</td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_on_error ?? true}
                    onChange={e => setForm(f => ({ ...f, notify_on_error: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_error_email ?? true}
                    onChange={e => setForm(f => ({ ...f, notify_error_email: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_error_telegram ?? true}
                    onChange={e => setForm(f => ({ ...f, notify_error_telegram: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
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

// ---------------------------------------------------------------------------
// Backup tab — export / import configuration
// ---------------------------------------------------------------------------
function BackupTab() {
  const [importing, setImporting] = useState(false)
  const [importOpts, setImportOpts] = useState({
    overwrite_servers: false,
    overwrite_schedule: true,
    overwrite_notifications: true,
  })
  const [importResult, setImportResult] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    setExporting(true)
    try {
      const data = await configApi.export()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const date = new Date().toISOString().slice(0, 10)
      a.download = `apt-dashboard-config-${date}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: unknown) {
      alert('Export failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setExporting(false)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      setImportResult(null)
      setImportError(null)
      setImporting(true)
      try {
        const parsed = JSON.parse(ev.target?.result as string)
        const res = await configApi.import(parsed, importOpts)
        const r = res.imported as Record<string, unknown>
        const parts = []
        if (r.groups) parts.push(`${r.groups} groups added`)
        if (r.servers) parts.push(`${r.servers} servers added`)
        if (r.skipped_servers) parts.push(`${r.skipped_servers} servers skipped (already exist)`)
        if (r.schedule) parts.push('schedule updated')
        if (r.notifications) parts.push('notifications updated')
        setImportResult(parts.length ? parts.join(', ') : 'Nothing changed')
      } catch (err: unknown) {
        setImportError('Import failed: ' + (err instanceof Error ? err.message : String(err)))
      } finally {
        setImporting(false)
        e.target.value = ''
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="space-y-8 max-w-lg">
      {/* Export */}
      <div className="card p-5 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Export Configuration</h2>
        <p className="text-xs text-text-muted">
          Downloads a JSON file containing all groups, servers, schedule settings, and notification settings.
          SSH keys are <span className="text-amber">not</span> included.
          The file may contain SMTP passwords and Telegram tokens — keep it secure.
        </p>
        <button onClick={handleExport} disabled={exporting} className="btn-primary">
          {exporting ? 'Exporting…' : 'Export to JSON'}
        </button>
      </div>

      {/* Import */}
      <div className="card p-5 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Import Configuration</h2>
        <p className="text-xs text-text-muted">
          Import a previously exported JSON file. Groups and servers are matched by name / hostname.
        </p>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-green"
              checked={importOpts.overwrite_servers}
              onChange={e => setImportOpts(o => ({ ...o, overwrite_servers: e.target.checked }))}
            />
            Overwrite existing servers (update hostname matches with imported values)
          </label>
          <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-green"
              checked={importOpts.overwrite_schedule}
              onChange={e => setImportOpts(o => ({ ...o, overwrite_schedule: e.target.checked }))}
            />
            Overwrite schedule settings
          </label>
          <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-green"
              checked={importOpts.overwrite_notifications}
              onChange={e => setImportOpts(o => ({ ...o, overwrite_notifications: e.target.checked }))}
            />
            Overwrite notification settings
          </label>
        </div>

        <label className={`btn-secondary inline-block cursor-pointer ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
          {importing ? 'Importing…' : 'Choose JSON file…'}
          <input type="file" accept=".json,application/json" className="hidden" onChange={handleFileChange} disabled={importing} />
        </label>

        {importResult && <p className="text-green text-sm">✓ {importResult}</p>}
        {importError && <p className="text-red text-sm">{importError}</p>}
      </div>

    </div>
  )
}

function CsvImport() {
  const [overwrite, setOverwrite] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setResult(null); setError(null); setLoading(true)
    try {
      const res = await configApi.importCsv(file, overwrite)
      setResult(`${res.added} server(s) added, ${res.skipped} skipped`)
    } catch (err: unknown) {
      setError('Import failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
      e.target.value = ''
    }
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
        <input type="checkbox" className="w-4 h-4 accent-green" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />
        Overwrite existing servers (match by hostname)
      </label>
      <label className={`btn-secondary inline-block cursor-pointer text-xs ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
        {loading ? 'Importing…' : 'Import CSV…'}
        <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} disabled={loading} />
      </label>
      {result && <p className="text-green text-sm">✓ {result}</p>}
      {error && <p className="text-red text-sm">{error}</p>}
    </div>
  )
}
