import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { servers as serversApi, groups as groupsApi, tags as tagsApi, scheduler as schedulerApi, notifications as notifApi, auth, config as configApi, aptcache as aptcacheApi, tailscale as tailscaleApi, maintenance as maintenanceApi, hooks as hooksApi } from '@/api/client'
import type { MaintenanceWindow, UpgradeHook } from '@/api/client'
import type { Server, ServerGroup, ScheduleConfig, NotificationConfig, Tag, AptCacheServer, TailscaleStatus } from '@/types'
import { useAuthStore } from '@/hooks/useAuth'

const TABS = ['Servers', 'Schedule', 'Preferences', 'Notifications', 'Infrastructure', 'Users', 'Account', 'Backup'] as const
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
  const { user } = useAuthStore()

  // Initial tab can be supplied via ?tab=<name> — used by the command palette
  // and other deep links. Falls back to 'Servers' for any unknown value.
  const initialTab: Tab = (() => {
    const param = new URLSearchParams(window.location.search).get('tab')
    if (param && (TABS as readonly string[]).includes(param)) return param as Tab
    return 'Servers'
  })()
  const [tab, setTab] = useState<Tab>(initialTab)

  // Re-sync if the query string changes (e.g. user opens the palette twice)
  useEffect(() => {
    function onPopState() {
      const param = new URLSearchParams(window.location.search).get('tab')
      if (param && (TABS as readonly string[]).includes(param)) setTab(param as Tab)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Hide admin-only tabs for read-only users
  const visibleTabs = TABS.filter(t => {
    if (t === 'Users' && !user?.is_admin) return false
    return true
  })

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-lg font-mono text-text-primary mb-4">Settings</h1>
      <div className="flex gap-1 mb-6 border-b border-border">
        {visibleTabs.map(t => (
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
      {tab === 'Schedule' && (
        <div className="space-y-6">
          <ScheduleTab />
          <MaintenanceWindowsSection />
          <UpgradeHooksSection />
        </div>
      )}
      {tab === 'Preferences' && <PreferencesTab />}
      {tab === 'Notifications' && <NotificationsTab />}
      {tab === 'Infrastructure' && <InfrastructureTab />}
      {tab === 'Users' && <UsersTab />}
      {tab === 'Account' && <AccountTab />}
      {tab === 'Backup' && <BackupTab />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OS EOL badge — shared helper for the Servers table (issue #57)
// ---------------------------------------------------------------------------
function EolBadge({ server }: { server: Server }) {
  const days = server.os_eol_days_remaining
  const sev = server.os_eol_severity
  if (days == null || !sev || sev === 'unknown') {
    return <span className="text-text-muted">—</span>
  }
  const colorClass =
    sev === 'expired' || sev === 'alert'
      ? 'text-red'
      : sev === 'warning'
        ? 'text-amber'
        : days < 365
          ? 'text-cyan'
          : 'text-text-muted'
  const isUbuntu = (server.os_info || '').toLowerCase().includes('ubuntu')
  const dateStr = server.os_eol_date || 'unknown'
  const tip = days < 0
    ? `Reached EOL ${dateStr} (${Math.abs(days)} days ago)${isUbuntu ? ' — ESM available via Ubuntu Pro' : ''}`
    : `EOL on ${dateStr} (${days} days)${isUbuntu ? ' — ESM available via Ubuntu Pro' : ''}`
  const label = days < 0 ? `EOL ${dateStr}` : `${days}d (${dateStr})`
  return <span className={colorClass} title={tip}>{label}</span>
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
  const [form, setForm] = useState({ name: '', hostname: '', username: '', ssh_port: '22', groupIds: [] as number[], tagIds: [] as number[], ssh_private_key: '', notes: '' })
  const [showAddSshKey, setShowAddSshKey] = useState(false)
  const [generatingKey, setGeneratingKey] = useState(false)
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null)
  const [copiedPublicKey, setCopiedPublicKey] = useState(false)
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
    notes: '',
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
  // Multi-select / bulk operations
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

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
      notes: s.notes ?? '',
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
        notes: editForm.notes.trim() || undefined,
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
        notes: form.notes.trim() || undefined,
      })
      setForm({ name: '', hostname: '', username: '', ssh_port: '22', groupIds: [], tagIds: [], ssh_private_key: '', notes: '' })
      setShowAddSshKey(false)
      setGeneratedPublicKey(null)
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
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
    load()
  }

  async function handleBulkDelete() {
    const count = selectedIds.size
    if (!confirm(`Delete ${count} server${count === 1 ? '' : 's'} and all their history? This cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      await Promise.all([...selectedIds].map(id => serversApi.remove(id)))
      setSelectedIds(new Set())
      load()
    } finally {
      setBulkDeleting(false)
    }
  }

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === serverList.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(serverList.map(s => s.id)))
    }
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
          <button className="btn-secondary text-xs" onClick={() => { setShowAddServer(true); setFormError(''); setGeneratedPublicKey(null); setShowAddSshKey(false) }}>+ Add Server</button>
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
              a.download = `apt-ui-servers-${new Date().toISOString().slice(0, 10)}.csv`
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

        {showAddServer && createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(2px)' }}
            onClick={e => { if (e.target === e.currentTarget) setShowAddServer(false) }}
          >
            <div className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">
              {/* Modal header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                <span className="font-mono text-sm font-medium text-text-primary">Add Server</span>
                <button onClick={() => setShowAddServer(false)} className="text-text-muted hover:text-text-primary transition-colors text-lg leading-none">×</button>
              </div>

              {/* Scrollable form body */}
              <form onSubmit={handleAddServer} className="overflow-y-auto flex-1 p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
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
                </div>

                <div>
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
                    {groupList.length === 0 && <span className="text-xs text-text-muted">No groups yet — create them in the Groups section.</span>}
                  </div>
                </div>

                <div>
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
                    {tagList.length === 0 && <span className="text-xs text-text-muted">No tags yet — create them in the Tags section.</span>}
                  </div>
                </div>

                {/* SSH key section */}
                <div className="border border-border/60 rounded p-3 bg-surface/40 space-y-2">
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full text-left text-sm font-medium text-text-primary hover:text-cyan transition-colors"
                    onClick={() => { setShowAddSshKey(v => !v); setGeneratedPublicKey(null) }}
                  >
                    <span className="text-base">🔑</span>
                    <span>{showAddSshKey ? '▾' : '▸'} Per-server SSH key</span>
                    <span className="ml-auto text-xs font-normal text-text-muted">optional — overrides the global key</span>
                  </button>
                  {showAddSshKey && (
                    <div className="space-y-2">
                      {/* Generate key pair button */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={generatingKey}
                          onClick={async () => {
                            setGeneratingKey(true)
                            setGeneratedPublicKey(null)
                            setCopiedPublicKey(false)
                            try {
                              const kp = await serversApi.generateSshKey()
                              setForm(f => ({ ...f, ssh_private_key: kp.private_key }))
                              setGeneratedPublicKey(kp.public_key)
                            } catch {
                              // ignore — user can paste manually
                            } finally {
                              setGeneratingKey(false)
                            }
                          }}
                          className="btn-secondary text-xs"
                        >
                          {generatingKey ? 'Generating…' : '⚡ Generate Key Pair'}
                        </button>
                        <span className="text-xs text-text-muted">or paste an existing private key below</span>
                      </div>

                      <textarea
                        className="input w-full font-mono text-xs h-28 resize-y"
                        placeholder="-----BEGIN ... PRIVATE KEY-----&#10;...&#10;-----END ... PRIVATE KEY-----"
                        value={form.ssh_private_key}
                        onChange={e => { setForm(f => ({ ...f, ssh_private_key: e.target.value })); setGeneratedPublicKey(null) }}
                      />
                      <p className="text-xs text-text-muted">Stored encrypted at rest. Leave empty to use the global <span className="font-mono">SSH_PRIVATE_KEY</span>.</p>

                      {/* Public key output */}
                      {generatedPublicKey && (
                        <div className="space-y-1 border border-green/30 rounded p-2 bg-green/5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-green font-medium">Public key — add this to <span className="font-mono">~/.ssh/authorized_keys</span> on the server:</span>
                            <button
                              type="button"
                              onClick={() => { navigator.clipboard.writeText(generatedPublicKey); setCopiedPublicKey(true); setTimeout(() => setCopiedPublicKey(false), 2000) }}
                              className="text-xs btn-secondary py-0.5 px-2 shrink-0"
                            >
                              {copiedPublicKey ? '✓ Copied' : 'Copy'}
                            </button>
                          </div>
                          <pre className="text-xs font-mono text-text-muted break-all whitespace-pre-wrap">{generatedPublicKey}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className="label">Notes <span className="text-text-muted font-normal">(optional)</span></label>
                  <textarea
                    className="input w-full text-xs h-16 resize-y"
                    placeholder="Free-text notes about this server…"
                    value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  />
                </div>

                {formError && <p className="text-red text-sm">{formError}</p>}

                <div className="flex gap-2 pt-1">
                  <button type="submit" className="btn-primary">Add Server</button>
                  <button type="button" className="btn-secondary" onClick={() => setShowAddServer(false)}>Cancel</button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

        {selectedIds.size > 0 && (
          <div className="flex items-center gap-3 px-3 py-2 bg-red/5 border border-red/20 rounded-lg text-sm">
            <span className="text-text-muted">{selectedIds.size} server{selectedIds.size === 1 ? '' : 's'} selected</span>
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="btn-danger text-xs py-0.5"
            >
              {bulkDeleting ? 'Deleting…' : `Delete ${selectedIds.size}`}
            </button>
            <button onClick={() => setSelectedIds(new Set())} className="text-xs text-text-muted hover:text-text-primary">Clear selection</button>
          </div>
        )}

        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-border text-text-muted text-xs uppercase">
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 accent-green"
                    checked={serverList.length > 0 && selectedIds.size === serverList.length}
                    ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < serverList.length }}
                    onChange={toggleSelectAll}
                    title="Select all"
                  />
                </th>
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">Hostname</th>
                <th className="text-left px-3 py-2">User / Port</th>
                <th className="text-left px-3 py-2">Group</th>
                <th className="text-left px-3 py-2">Tags</th>
                <th className="text-left px-3 py-2">OS EOL</th>
                <th className="text-left px-3 py-2">Enabled</th>
                <th className="text-left px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {serverList.map((s, i) => editingServer === s.id ? (
                /* ── Inline edit row ── */
                <tr key={s.id} className="border-b border-border/50 bg-surface-2/50">
                  <td className="px-3 py-2">
                    <input type="checkbox" className="w-3.5 h-3.5 accent-green" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} />
                  </td>
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
                  <td className="px-3 py-2 text-xs font-mono">
                    <EolBadge server={s} />
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
                      <div className="pt-1">
                        <label className="text-xs text-text-muted">Notes</label>
                        <textarea
                          className="input w-full text-xs py-1 h-14 resize-y mt-0.5"
                          placeholder="Free-text notes…"
                          value={editForm.notes}
                          onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                /* ── Normal display row ── */
                <tr key={s.id} className={`border-b border-border/50 ${selectedIds.has(s.id) ? 'bg-green/5' : i % 2 === 0 ? '' : 'bg-surface-2/30'}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" className="w-3.5 h-3.5 accent-green" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} />
                  </td>
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
                  <td className="px-3 py-2 text-xs font-mono">
                    <EolBadge server={s} />
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
                <tr><td colSpan={9} className="px-3 py-6 text-center text-text-muted">No servers added yet.</td></tr>
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function describeCronField(val: string, singular: string, plural: string, names?: string[]): string {
  if (val === '*') return `every ${singular}`
  if (val.startsWith('*/')) {
    const n = parseInt(val.slice(2))
    return `every ${n} ${n === 1 ? singular : plural}`
  }
  const parts = val.split(',').map(p => {
    if (p.includes('-')) return p
    const n = parseInt(p)
    return names ? (names[n] ?? p) : p
  })
  return parts.join(', ')
}

function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, month, dow] = parts
  const validPart = (v: string) => /^(\*|(\*\/\d+)|\d+(,\d+)*(-\d+)?)$/.test(v)
  if (!parts.every(validPart)) return null

  const minuteDesc = describeCronField(min, 'minute', 'minutes')
  const hourDesc = describeCronField(hour, 'hour', 'hours')
  const domDesc = describeCronField(dom, 'day', 'days')
  const monthDesc = describeCronField(month, 'month', 'months', MONTHS)
  const dowDesc = describeCronField(dow, 'day', 'days', WEEKDAYS)

  if (min !== '*' && hour !== '*' && dom === '*' && month === '*' && dow === '*') {
    const h = parseInt(hour)
    const m = parseInt(min)
    if (!isNaN(h) && !isNaN(m)) {
      return `Daily at ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
  }
  if (min !== '*' && hour !== '*' && dom === '*' && month === '*' && dow !== '*') {
    const h = parseInt(hour)
    const m = parseInt(min)
    if (!isNaN(h) && !isNaN(m)) {
      return `Every ${dowDesc} at ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
  }
  if (hour.startsWith('*/') && min !== '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${describeCronField(hour, 'hour', 'hours')} at minute ${min}`
  }

  return `At ${minuteDesc} past ${hourDesc}, ${domDesc} of ${monthDesc}, ${dowDesc}`
}

function CronInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const desc = describeCron(value)
  const invalid = value.trim() !== '' && desc === null
  return (
    <div className="space-y-1">
      <input
        className={`input mb-0 ${invalid ? 'border-red/60 focus:border-red' : ''}`}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="0 6 * * *"
        spellCheck={false}
      />
      {invalid && <p className="text-xs text-red">Invalid cron expression — must be 5 fields (min hour dom month dow)</p>}
      {desc && <p className="text-xs text-green font-mono">{desc}</p>}
    </div>
  )
}

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
          <CronInput value={form.check_cron ?? ''} onChange={v => setForm(f => ({ ...f, check_cron: v }))} />
          <div className="flex flex-wrap gap-1 mt-2">
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
        <h2 className="text-sm font-medium text-text-primary">Reachability Check</h2>
        <p className="text-xs text-text-muted">Controls how often the dashboard probes each server via SSH to show the reachability indicator. Results are cached server-side; set to 0 to disable.</p>
        <div className="flex items-center gap-3">
          <label className="text-sm text-text-muted">Cache TTL (minutes)</label>
          <input
            type="number"
            className="input w-24"
            min={0}
            max={60}
            value={form.reachability_ttl_minutes ?? 5}
            onChange={e => setForm(f => ({ ...f, reachability_ttl_minutes: parseInt(e.target.value) || 0 }))}
          />
          <span className="text-xs text-text-muted">{(form.reachability_ttl_minutes ?? 5) === 0 ? '— disabled' : `re-checks every ${form.reachability_ttl_minutes ?? 5} min`}</span>
        </div>

        {/* Save button lives inside the last form section so it's clearly tied
            to the schedule above, not the unrelated Maintenance Windows section below. */}
        <div className="flex items-center justify-end gap-3 pt-3 mt-2 border-t border-border/30">
          {saved && <span className="text-xs text-green">✓ Saved</span>}
          <button type="submit" className="btn-primary text-sm">Save Schedule</button>
        </div>
      </section>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Maintenance Windows section (issue #40)
// ---------------------------------------------------------------------------

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function minutesToHHMM(m: number): string {
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function formatDays(bitmask: number): string {
  if (bitmask === 127) return 'Every day'
  if (bitmask === 0b0011111) return 'Weekdays'
  if (bitmask === 0b1100000) return 'Weekends'
  return DAY_LABELS.filter((_, i) => bitmask & (1 << i)).join(', ')
}

function MaintenanceWindowsSection() {
  const [windows, setWindows] = useState<MaintenanceWindow[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [editing, setEditing] = useState<Partial<MaintenanceWindow> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSubscribe, setShowSubscribe] = useState(false)

  async function reload() {
    try {
      const [w, s] = await Promise.all([maintenanceApi.list(), serversApi.list()])
      setWindows(w)
      setServers(s)
    } catch (e: unknown) {
      setError((e as Error).message)
    }
  }
  useEffect(() => { reload() }, [])

  function newWindow() {
    setEditing({
      server_id: null,
      name: '',
      start_minutes: 9 * 60,   // 09:00
      end_minutes: 17 * 60,    // 17:00
      days_of_week: 0b0011111, // Mon-Fri
      enabled: true,
    })
  }

  async function save() {
    if (!editing) return
    setError(null)
    try {
      if (editing.id) {
        await maintenanceApi.update(editing.id, editing as any)
      } else {
        await maintenanceApi.create(editing as any)
      }
      setEditing(null)
      await reload()
    } catch (e: unknown) {
      setError((e as Error).message)
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this maintenance window?')) return
    await maintenanceApi.remove(id)
    await reload()
  }

  function toggleDay(bit: number) {
    if (!editing) return
    const cur = editing.days_of_week ?? 0
    setEditing({ ...editing, days_of_week: cur ^ (1 << bit) })
  }

  return (
    <section className="card p-4 space-y-3 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-text-primary">Maintenance Windows</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Auto-upgrade and (with confirmation) Upgrade All skip servers inside an active deny window.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowSubscribe(true)} className="btn-secondary text-xs" title="Subscribe to maintenance windows in your calendar app">Subscribe in Calendar</button>
          <button onClick={newWindow} className="btn-secondary text-xs">+ Add window</button>
        </div>
      </div>

      {showSubscribe && createPortal(
        <CalendarSubscribeModal onClose={() => setShowSubscribe(false)} />,
        document.body,
      )}

      {error && <p className="text-xs text-red font-mono">{error}</p>}

      {windows.length === 0 && !editing ? (
        <p className="text-xs text-text-muted py-2">No maintenance windows configured.</p>
      ) : (
        <div className="space-y-1">
          {windows.map(w => {
            const scope = w.server_id == null
              ? <span className="text-purple">Global</span>
              : <span className="text-cyan">{servers.find(s => s.id === w.server_id)?.name ?? `server #${w.server_id}`}</span>
            return (
              <div key={w.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-border/30 last:border-0 font-mono">
                <span className={`w-2 h-2 rounded-full shrink-0 ${w.enabled ? 'bg-green' : 'bg-gray-500'}`} title={w.enabled ? 'enabled' : 'disabled'} />
                <span className="text-text-primary truncate w-40">{w.name}</span>
                <span className="text-text-muted shrink-0">{scope}</span>
                <span className="text-text-muted shrink-0">{minutesToHHMM(w.start_minutes)}–{minutesToHHMM(w.end_minutes)}</span>
                <span className="text-text-muted/70 shrink-0 hidden sm:inline">{formatDays(w.days_of_week)}</span>
                <span className="ml-auto flex gap-2">
                  <button onClick={() => setEditing(w)} className="text-cyan/80 hover:text-cyan">Edit</button>
                  <button onClick={() => remove(w.id)} className="text-red/70 hover:text-red">Delete</button>
                </span>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <div className="border-t border-border/40 pt-4 mt-3">
          <h3 className="text-xs uppercase tracking-wide text-text-muted mb-3">
            {editing.id ? 'Edit window' : 'New window'}
          </h3>

          <div className="space-y-4">
            {/* 1. Name */}
            <div>
              <label className="label">Name</label>
              <input
                type="text"
                value={editing.name ?? ''}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                className="input text-sm"
                placeholder="e.g. Business hours"
                autoFocus
              />
            </div>

            {/* 2. Scope */}
            <div>
              <label className="label">Applies to</label>
              <select
                value={editing.server_id ?? ''}
                onChange={e => setEditing({ ...editing, server_id: e.target.value ? parseInt(e.target.value) : null })}
                className="input text-sm"
              >
                <option value="">Global — all servers</option>
                {servers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>)}
              </select>
            </div>

            {/* 3. Days of week */}
            <div>
              <label className="label">Days</label>
              <div className="flex gap-1 flex-wrap">
                {DAY_LABELS.map((d, i) => {
                  const on = !!((editing.days_of_week ?? 0) & (1 << i))
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleDay(i)}
                      className={`px-3 py-1.5 rounded text-xs font-mono border transition-colors min-w-[3rem] ${
                        on
                          ? 'border-green text-green bg-green/10'
                          : 'border-border text-text-muted hover:text-text-primary'
                      }`}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
              <div className="flex gap-2 mt-2 text-[10px] font-mono text-text-muted">
                <button type="button" onClick={() => setEditing({ ...editing, days_of_week: 127 })} className="hover:text-text-primary">All days</button>
                <span className="text-text-muted/40">·</span>
                <button type="button" onClick={() => setEditing({ ...editing, days_of_week: 0b0011111 })} className="hover:text-text-primary">Weekdays</button>
                <span className="text-text-muted/40">·</span>
                <button type="button" onClick={() => setEditing({ ...editing, days_of_week: 0b1100000 })} className="hover:text-text-primary">Weekends</button>
              </div>
            </div>

            {/* 4. Time range */}
            <div>
              <label className="label">Time range</label>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={minutesToHHMM(editing.start_minutes ?? 0)}
                  onChange={e => setEditing({ ...editing, start_minutes: hhmmToMinutes(e.target.value) })}
                  className="input text-sm font-mono w-32"
                />
                <span className="text-text-muted text-sm">→</span>
                <input
                  type="time"
                  value={minutesToHHMM(editing.end_minutes ?? 0)}
                  onChange={e => setEditing({ ...editing, end_minutes: hhmmToMinutes(e.target.value) })}
                  className="input text-sm font-mono w-32"
                />
                {(editing.start_minutes ?? 0) > (editing.end_minutes ?? 0) && (
                  <span className="text-xs text-amber font-mono">wraps midnight</span>
                )}
              </div>
            </div>

            {/* 5. Enabled */}
            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="mw-enabled"
                checked={editing.enabled !== false}
                onChange={e => setEditing({ ...editing, enabled: e.target.checked })}
                className="w-4 h-4 accent-green"
              />
              <label htmlFor="mw-enabled" className="text-sm text-text-muted cursor-pointer select-none">
                Enabled
              </label>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-border/30">
            <button onClick={() => setEditing(null)} className="btn-secondary text-sm">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!editing.name?.trim() || (editing.days_of_week ?? 0) === 0}
              className="btn-primary text-sm"
            >
              {editing.id ? 'Save changes' : 'Create window'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Calendar subscription modal (issue #59)
// ---------------------------------------------------------------------------

function CalendarSubscribeModal({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<import('@/api/client').ApiTokenSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [newName, setNewName] = useState('apt-ui calendar feed')
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function reload() {
    try {
      const t = await auth.listTokens()
      setTokens(t)
      if (t.length && selectedId == null) setSelectedId(t[0].id)
    } catch {
      setTokens([])
    }
  }
  useEffect(() => { reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  async function createToken(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!newName.trim()) {
      setError('Name required')
      return
    }
    setCreating(true)
    try {
      const t = await auth.createToken(newName.trim())
      setCreatedToken(t.token)
      await reload()
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  // The URL only contains an actual usable token immediately after creation
  // (we never receive the raw value of pre-existing tokens — it isn't stored).
  // For pre-existing tokens, render a placeholder reminding the user to paste
  // the token they saved when minting it.
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const tokenForUrl = createdToken ?? '<paste-your-api-token-here>'
  const url = `${origin}/api/calendar.ics?token=${tokenForUrl}`

  function copyUrl() {
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h3 className="font-mono text-sm text-text-primary">Subscribe in Calendar</h3>
          <button onClick={onClose} className="text-text-muted hover:text-red">✕</button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-xs text-text-muted">
            Paste this URL into Apple Calendar, Google Calendar, or Thunderbird as a
            new calendar subscription. Each enabled maintenance window appears as a
            recurring event.
          </p>

          {tokens.length === 0 && !createdToken ? (
            <form onSubmit={createToken} className="space-y-3 rounded border border-border/40 p-3">
              <p className="text-xs text-text-muted">
                You don&apos;t have any API tokens yet. Create one to use as the calendar feed credential.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="input flex-1 text-sm"
                  maxLength={100}
                  autoFocus
                />
                <button type="submit" disabled={creating || !newName.trim()} className="btn-primary text-sm">
                  {creating ? '…' : 'Create token'}
                </button>
              </div>
              {error && <p className="text-red text-xs">{error}</p>}
            </form>
          ) : !createdToken ? (
            <div className="space-y-2">
              <label className="label">Use existing API token</label>
              <select
                value={selectedId ?? ''}
                onChange={e => setSelectedId(e.target.value ? parseInt(e.target.value) : null)}
                className="input text-sm"
              >
                {tokens.map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.prefix}…)</option>
                ))}
              </select>
              <p className="text-[10px] text-amber/80 mt-1">
                The raw token value is shown only once at creation — paste yours into the URL below
                in place of <span className="font-mono">&lt;paste-your-api-token-here&gt;</span>.
                If you don&apos;t have it saved, mint a new token below.
              </p>
              <form onSubmit={createToken} className="flex items-center gap-2 pt-2 border-t border-border/30">
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="input flex-1 text-sm"
                  placeholder="New token name"
                  maxLength={100}
                />
                <button type="submit" disabled={creating || !newName.trim()} className="btn-secondary text-sm">
                  {creating ? '…' : 'Mint new token'}
                </button>
              </form>
              {error && <p className="text-red text-xs">{error}</p>}
            </div>
          ) : (
            <div className="rounded border border-amber/40 bg-amber/5 p-3 space-y-1">
              <p className="text-xs text-amber font-medium">Token created — copy now, it will not be shown again.</p>
              <code className="block font-mono text-xs text-text-primary bg-bg/50 p-2 rounded break-all select-all">{createdToken}</code>
            </div>
          )}

          <div>
            <label className="label">Calendar feed URL</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-xs text-text-primary bg-bg/50 p-2 rounded break-all select-all">{url}</code>
              <button onClick={copyUrl} className="btn-secondary text-xs">{copied ? 'Copied!' : 'Copy'}</button>
            </div>
          </div>

          <p className="text-[10px] text-text-muted/80">
            The URL contains the token because calendar clients can&apos;t send custom
            <span className="font-mono"> Authorization </span>
            headers. Treat it like a password and revoke the token if it leaks.
          </p>

          <div className="flex justify-end pt-3 border-t border-border/30">
            <button onClick={onClose} className="btn-secondary text-sm">Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pre/post-upgrade hooks (issue #29)
// ---------------------------------------------------------------------------

function UpgradeHooksSection() {
  const [hooks, setHooks] = useState<UpgradeHook[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [editing, setEditing] = useState<Partial<UpgradeHook> | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    try {
      const [h, s] = await Promise.all([hooksApi.list(), serversApi.list()])
      setHooks(h)
      setServers(s)
    } catch (e: unknown) {
      setError((e as Error).message)
    }
  }
  useEffect(() => { reload() }, [])

  function newHook(phase: 'pre' | 'post') {
    setEditing({
      server_id: null,
      name: '',
      phase,
      command: '',
      sort_order: 0,
      enabled: true,
    })
  }

  async function save() {
    if (!editing) return
    setError(null)
    try {
      if (editing.id) {
        await hooksApi.update(editing.id, editing as any)
      } else {
        await hooksApi.create(editing as any)
      }
      setEditing(null)
      await reload()
    } catch (e: unknown) {
      setError((e as Error).message)
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this hook?')) return
    await hooksApi.remove(id)
    await reload()
  }

  const preHooks = hooks.filter(h => h.phase === 'pre')
  const postHooks = hooks.filter(h => h.phase === 'post')

  function renderHookList(list: UpgradeHook[], emptyMsg: string) {
    if (list.length === 0) return <p className="text-xs text-text-muted py-2">{emptyMsg}</p>
    return (
      <div className="space-y-1">
        {list.map(h => {
          const scope = h.server_id == null
            ? <span className="text-purple">Global</span>
            : <span className="text-cyan">{servers.find(s => s.id === h.server_id)?.name ?? `server #${h.server_id}`}</span>
          return (
            <div key={h.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-border/30 last:border-0 font-mono">
              <span className={`w-2 h-2 rounded-full shrink-0 ${h.enabled ? 'bg-green' : 'bg-gray-500'}`} title={h.enabled ? 'enabled' : 'disabled'} />
              <span className="text-text-primary truncate w-32">{h.name}</span>
              <span className="text-text-muted shrink-0">{scope}</span>
              <span className="text-text-muted/70 truncate flex-1" title={h.command}>{h.command}</span>
              <span className="ml-auto flex gap-2 shrink-0">
                <button onClick={() => setEditing(h)} className="text-cyan/80 hover:text-cyan">Edit</button>
                <button onClick={() => remove(h.id)} className="text-red/70 hover:text-red">Delete</button>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <section className="card p-4 space-y-4 max-w-3xl">
      <div>
        <h2 className="text-sm font-medium text-text-primary">Pre/Post-Upgrade Hooks</h2>
        <p className="text-xs text-text-muted mt-0.5">
          Shell commands run on the managed server before and after an upgrade. A failing pre-hook aborts the upgrade;
          post-hooks always run. Useful for stopping/restarting services or running smoke tests.
        </p>
      </div>

      {error && <p className="text-xs text-red font-mono">{error}</p>}

      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs uppercase tracking-wide text-text-muted">Pre-upgrade ({preHooks.length})</h3>
            <button onClick={() => newHook('pre')} className="btn-secondary text-xs">+ Add pre-hook</button>
          </div>
          {renderHookList(preHooks, 'No pre-hooks configured.')}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs uppercase tracking-wide text-text-muted">Post-upgrade ({postHooks.length})</h3>
            <button onClick={() => newHook('post')} className="btn-secondary text-xs">+ Add post-hook</button>
          </div>
          {renderHookList(postHooks, 'No post-hooks configured.')}
        </div>
      </div>

      {editing && (
        <div className="border-t border-border/40 pt-4 mt-3">
          <h3 className="text-xs uppercase tracking-wide text-text-muted mb-3">
            {editing.id ? 'Edit hook' : `New ${editing.phase}-hook`}
          </h3>

          <div className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input
                type="text"
                value={editing.name ?? ''}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                className="input text-sm"
                placeholder="e.g. Stop nginx"
                autoFocus
              />
            </div>

            <div>
              <label className="label">Phase</label>
              <select
                value={editing.phase ?? 'pre'}
                onChange={e => setEditing({ ...editing, phase: e.target.value as 'pre' | 'post' })}
                className="input text-sm"
              >
                <option value="pre">Pre-upgrade (failure aborts)</option>
                <option value="post">Post-upgrade (always runs)</option>
              </select>
            </div>

            <div>
              <label className="label">Applies to</label>
              <select
                value={editing.server_id ?? ''}
                onChange={e => setEditing({ ...editing, server_id: e.target.value ? parseInt(e.target.value) : null })}
                className="input text-sm"
              >
                <option value="">Global — all servers</option>
                {servers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>)}
              </select>
            </div>

            <div>
              <label className="label">Command</label>
              <textarea
                value={editing.command ?? ''}
                onChange={e => setEditing({ ...editing, command: e.target.value })}
                className="input text-sm font-mono"
                rows={3}
                placeholder="systemctl stop nginx"
              />
              <p className="text-[10px] text-text-muted mt-1">Runs as the SSH user on the managed server. Use sudo if needed.</p>
            </div>

            <div>
              <label className="label">Sort order</label>
              <input
                type="number"
                value={editing.sort_order ?? 0}
                onChange={e => setEditing({ ...editing, sort_order: parseInt(e.target.value) || 0 })}
                className="input text-sm w-24"
              />
              <p className="text-[10px] text-text-muted mt-1">Lower runs first.</p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="hk-enabled"
                checked={editing.enabled !== false}
                onChange={e => setEditing({ ...editing, enabled: e.target.checked })}
                className="w-4 h-4 accent-green"
              />
              <label htmlFor="hk-enabled" className="text-sm text-text-muted cursor-pointer select-none">Enabled</label>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-border/30">
            <button onClick={() => setEditing(null)} className="btn-secondary text-sm">Cancel</button>
            <button
              onClick={save}
              disabled={!editing.name?.trim() || !editing.command?.trim()}
              className="btn-primary text-sm"
            >
              {editing.id ? 'Save changes' : 'Create hook'}
            </button>
          </div>
        </div>
      )}
    </section>
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
    <div className="space-y-6 max-w-xl">
    <form onSubmit={handleSave} className="space-y-6">
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
              <CronInput value={form.auto_upgrade_cron ?? ''} onChange={v => setForm(f => ({ ...f, auto_upgrade_cron: v }))} />
            </div>
            <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
              <input type="checkbox" checked={form.allow_phased_on_auto ?? false} onChange={e => setForm(f => ({ ...f, allow_phased_on_auto: e.target.checked }))} className="w-4 h-4 accent-amber" />
              Allow phased updates in auto-upgrade
            </label>

            {/* Staged rollout (issue #41) */}
            <div className="border-t border-border/30 pt-3 space-y-3">
              <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.staged_rollout_enabled ?? false}
                  onChange={e => setForm(f => ({ ...f, staged_rollout_enabled: e.target.checked }))}
                  className="w-4 h-4 accent-cyan"
                />
                Use staged rollout (rings)
              </label>
              {form.staged_rollout_enabled && (
                <div className="pl-6 space-y-2">
                  <p className="text-xs text-text-muted leading-snug">
                    Auto-upgrade processes servers grouped by their <span className="font-mono">ring:*</span> tag in alphabetical order
                    (e.g. <span className="font-mono">ring:test</span> → <span className="font-mono">ring:prod</span>).
                    Servers without a ring tag go in <span className="font-mono">ring:default</span>.
                    If any server in a ring fails, the rollout aborts before promoting to the next ring.
                  </p>
                  <div className="flex items-center gap-2">
                    <label className="label mb-0">Delay between rings</label>
                    <input
                      type="number"
                      className="input w-24"
                      min={1}
                      max={168}
                      value={form.ring_promotion_delay_hours ?? 24}
                      onChange={e => setForm(f => ({ ...f, ring_promotion_delay_hours: parseInt(e.target.value) || 24 }))}
                    />
                    <span className="text-xs text-text-muted">hours</span>
                  </div>
                </div>
              )}
            </div>

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

      <DisplayPreferencesSection />
      <button type="submit" className="btn-primary">{saved ? '✓ Saved' : 'Save Preferences'}</button>
    </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Display preferences (localStorage only — no backend)
// ---------------------------------------------------------------------------

const SORT_OPTIONS = [
  { value: 'name',    label: 'Name' },
  { value: 'status',  label: 'Status' },
  { value: 'updates', label: 'Update count' },
  { value: 'group',   label: 'Group' },
] as const

function DisplayPreferencesSection() {
  const [defaultSort, setDefaultSort] = useState(
    () => localStorage.getItem('dashboard:sortBy') ?? 'status'
  )
  const [alwaysShowReboot, setAlwaysShowReboot] = useState(
    () => localStorage.getItem('dashboard:alwaysShowReboot') === 'true'
  )

  function handleSortChange(v: string) {
    setDefaultSort(v)
    localStorage.setItem('dashboard:sortBy', v)
  }

  function handleAlwaysShowRebootChange(v: boolean) {
    setAlwaysShowReboot(v)
    localStorage.setItem('dashboard:alwaysShowReboot', String(v))
  }

  return (
    <section className="card p-4 space-y-3">
      <h2 className="text-sm font-medium text-text-primary">Display</h2>
      <p className="text-xs text-text-muted">These preferences are stored locally in your browser and apply only to this device.</p>
      <div>
        <label className="label">Always show Reboot button</label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={alwaysShowReboot}
            onChange={e => handleAlwaysShowRebootChange(e.target.checked)}
            className="w-4 h-4 accent-green"
          />
          <span className="text-sm text-text-primary">Show Reboot button regardless of reboot-required state</span>
        </label>
        <p className="text-xs text-text-muted mt-1">When enabled, the Reboot button is always visible on server cards and the server detail page, not only when the system reports a reboot is needed.</p>
      </div>
      <div>
        <label className="label">Default dashboard sort order</label>
        <select className="input w-48" value={defaultSort} onChange={e => handleSortChange(e.target.value)}>
          {SORT_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p className="text-xs text-text-muted mt-1">Takes effect on the next page load. Changing the sort on the dashboard also updates this.</p>
      </div>
    </section>
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

      {/* Webhook */}
      <section className="card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-primary">Outbound Webhook</h2>
          <input type="checkbox" checked={form.webhook_enabled ?? false} onChange={e => setForm(f => ({ ...f, webhook_enabled: e.target.checked }))} className="w-4 h-4 accent-green" />
        </div>
        {form.webhook_enabled && (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              POST JSON to a URL for each event (daily summary, upgrade complete, errors).
              Events: <span className="font-mono text-cyan">daily_summary</span>, <span className="font-mono text-cyan">upgrade_complete</span>, <span className="font-mono text-cyan">upgrade_failed</span>, <span className="font-mono text-cyan">upgrade_all_complete</span>.
            </p>
            <div>
              <label className="label">Webhook URL</label>
              <input className="input" type="url" placeholder="https://…" value={form.webhook_url ?? ''} onChange={e => setForm(f => ({ ...f, webhook_url: e.target.value }))} />
            </div>
            <div>
              <label className="label">Secret (optional — HMAC-SHA256 signing)</label>
              <input type="password" className="input" placeholder="unchanged" value={form.webhook_secret ?? ''} onChange={e => setForm(f => ({ ...f, webhook_secret: e.target.value }))} />
              <p className="text-xs text-text-muted mt-1">If set, each request includes an <span className="font-mono">X-Hub-Signature-256</span> header.</p>
            </div>
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
                <th className="text-center py-1 px-3">Webhook</th>
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
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.daily_summary_webhook ?? true}
                    disabled={!form.webhook_enabled}
                    onChange={e => setForm(f => ({ ...f, daily_summary_webhook: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
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
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_upgrade_webhook ?? true}
                    disabled={!form.webhook_enabled}
                    onChange={e => setForm(f => ({ ...f, notify_upgrade_webhook: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
                </td>
              </tr>
              {/* Security updates found */}
              <tr>
                <td className="py-2 pr-4">
                  <div className="text-text-primary">Security updates found</div>
                  <div className="text-xs text-text-muted">Fires after each check-all when any server has pending security updates</div>
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_security_updates ?? true}
                    onChange={e => setForm(f => ({ ...f, notify_security_updates: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_security_email ?? true}
                    disabled={!form.notify_security_updates}
                    onChange={e => setForm(f => ({ ...f, notify_security_email: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_security_telegram ?? true}
                    disabled={!form.notify_security_updates}
                    onChange={e => setForm(f => ({ ...f, notify_security_telegram: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_security_webhook ?? true}
                    disabled={!form.webhook_enabled || !form.notify_security_updates}
                    onChange={e => setForm(f => ({ ...f, notify_security_webhook: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
                </td>
              </tr>
              {/* Reboot required */}
              <tr>
                <td className="py-2 pr-4">
                  <div className="text-text-primary">Reboot required</div>
                  <div className="text-xs text-text-muted">Fires after each check-all when any server needs a reboot</div>
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_reboot_required ?? true}
                    onChange={e => setForm(f => ({ ...f, notify_reboot_required: e.target.checked }))}
                    className="w-4 h-4 accent-green" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_reboot_email ?? true}
                    disabled={!form.notify_reboot_required}
                    onChange={e => setForm(f => ({ ...f, notify_reboot_email: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_reboot_telegram ?? true}
                    disabled={!form.notify_reboot_required}
                    onChange={e => setForm(f => ({ ...f, notify_reboot_telegram: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
                </td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_reboot_webhook ?? true}
                    disabled={!form.webhook_enabled || !form.notify_reboot_required}
                    onChange={e => setForm(f => ({ ...f, notify_reboot_webhook: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
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
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" checked={form.notify_error_webhook ?? true}
                    disabled={!form.webhook_enabled}
                    onChange={e => setForm(f => ({ ...f, notify_error_webhook: e.target.checked }))}
                    className="w-4 h-4 accent-green disabled:opacity-30" />
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
// Users tab — multi-user management (issue #39)
// ---------------------------------------------------------------------------

function UsersTab() {
  const { user: currentUser } = useAuthStore()
  const [users, setUsers] = useState<import('@/api/client').UserSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [resetPwFor, setResetPwFor] = useState<import('@/api/client').UserSummary | null>(null)

  // Create form
  const [newUser, setNewUser] = useState<{ username: string; password: string; confirm: string; is_admin: boolean }>({
    username: '', password: '', confirm: '', is_admin: false,
  })
  const [createMsg, setCreateMsg] = useState<string | null>(null)

  // Password reset
  const [resetPw, setResetPw] = useState({ password: '', confirm: '' })
  const [resetMsg, setResetMsg] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      setUsers(await auth.listUsers())
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { reload() }, [])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setCreateMsg(null)
    setError(null)
    if (!newUser.username.trim() || !newUser.password) {
      setError('Username and password required')
      return
    }
    if (newUser.password !== newUser.confirm) {
      setError('Passwords do not match')
      return
    }
    try {
      await auth.createUser({
        username: newUser.username.trim(),
        password: newUser.password,
        is_admin: newUser.is_admin,
      })
      setCreateMsg(`User "${newUser.username}" created`)
      setNewUser({ username: '', password: '', confirm: '', is_admin: false })
      setCreating(false)
      await reload()
    } catch (e: unknown) {
      setError((e as Error).message)
    }
  }

  async function toggleRole(u: import('@/api/client').UserSummary) {
    try {
      await auth.updateUser(u.id, { is_admin: !u.is_admin })
      await reload()
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }

  async function remove(u: import('@/api/client').UserSummary) {
    if (!confirm(`Delete user "${u.username}"? This also revokes all their API tokens.`)) return
    try {
      await auth.deleteUser(u.id)
      await reload()
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    setResetMsg(null)
    if (!resetPwFor) return
    if (!resetPw.password || resetPw.password !== resetPw.confirm) {
      setResetMsg('Passwords do not match')
      return
    }
    try {
      await auth.updateUser(resetPwFor.id, { password: resetPw.password })
      setResetMsg(`Password reset for ${resetPwFor.username}`)
      setTimeout(() => {
        setResetPwFor(null)
        setResetPw({ password: '', confirm: '' })
        setResetMsg(null)
      }, 1200)
    } catch (e: unknown) {
      setResetMsg((e as Error).message)
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-sm font-medium text-text-primary mb-1">Users</h2>
        <p className="text-xs text-text-muted">
          Manage user accounts. Read-only users can browse the dashboard but cannot trigger upgrades, edit servers, or change settings.
        </p>
      </div>

      {error && <div className="card border-red/40 bg-red/5 p-3 text-sm text-red font-mono">{error}</div>}

      {/* User list */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="text-left px-3 py-2 font-normal text-xs uppercase tracking-wide">Username</th>
              <th className="text-left px-3 py-2 font-normal text-xs uppercase tracking-wide">Role</th>
              <th className="text-left px-3 py-2 font-normal text-xs uppercase tracking-wide">Last login</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {loading ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-text-muted text-sm">Loading…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-text-muted text-sm">No users.</td></tr>
            ) : (
              users.map(u => {
                const isMe = currentUser?.id === u.id
                return (
                  <tr key={u.id} className="hover:bg-surface/50">
                    <td className="px-3 py-2 font-mono">
                      {u.username}
                      {isMe && <span className="ml-2 text-[10px] text-text-muted/70 uppercase tracking-wide">(you)</span>}
                    </td>
                    <td className="px-3 py-2">
                      {u.is_admin ? (
                        <span className="badge bg-green/10 text-green border border-green/30 text-xs">admin</span>
                      ) : (
                        <span className="badge bg-blue/10 text-blue border border-blue/30 text-xs">read-only</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-text-muted">
                      {u.last_login ? new Date(u.last_login).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-3 text-xs">
                        <button onClick={() => toggleRole(u)} className="text-cyan/80 hover:text-cyan" title={u.is_admin ? 'Demote to read-only' : 'Promote to admin'}>
                          {u.is_admin ? 'Demote' : 'Promote'}
                        </button>
                        <button onClick={() => { setResetPwFor(u); setResetPw({ password: '', confirm: '' }); setResetMsg(null) }} className="text-amber/80 hover:text-amber">
                          Reset password
                        </button>
                        {!isMe && (
                          <button onClick={() => remove(u)} className="text-red/70 hover:text-red">Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add user button or form */}
      {!creating ? (
        <button onClick={() => { setCreating(true); setCreateMsg(null); setError(null) }} className="btn-primary">
          + Add user
        </button>
      ) : (
        <form onSubmit={create} className="card p-4 space-y-4">
          <h3 className="text-xs uppercase tracking-wide text-text-muted">New user</h3>

          <div>
            <label className="label">Username</label>
            <input
              type="text"
              value={newUser.username}
              onChange={e => setNewUser({ ...newUser, username: e.target.value })}
              className="input text-sm"
              autoFocus
              maxLength={100}
            />
          </div>

          <div>
            <label className="label">Password</label>
            <input
              type="password"
              value={newUser.password}
              onChange={e => setNewUser({ ...newUser, password: e.target.value })}
              className="input text-sm"
            />
          </div>

          <div>
            <label className="label">Confirm password</label>
            <input
              type="password"
              value={newUser.confirm}
              onChange={e => setNewUser({ ...newUser, confirm: e.target.value })}
              className="input text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="new-admin"
              checked={newUser.is_admin}
              onChange={e => setNewUser({ ...newUser, is_admin: e.target.checked })}
              className="w-4 h-4 accent-green"
            />
            <label htmlFor="new-admin" className="text-sm text-text-muted cursor-pointer select-none">
              Admin (can mutate state)
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border/30">
            <button type="button" onClick={() => { setCreating(false); setError(null) }} className="btn-secondary text-sm">
              Cancel
            </button>
            <button type="submit" className="btn-primary text-sm">
              Create user
            </button>
          </div>
        </form>
      )}
      {createMsg && <p className="text-green text-sm">{createMsg}</p>}

      {/* Password reset modal */}
      {resetPwFor && createPortal(
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setResetPwFor(null)}>
          <div className="bg-surface border border-border rounded-lg w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h3 className="font-mono text-sm text-text-primary">Reset password</h3>
              <button onClick={() => setResetPwFor(null)} className="text-text-muted hover:text-red">✕</button>
            </div>
            <form onSubmit={submitReset} className="p-4 space-y-4">
              <p className="text-sm text-text-muted">
                Set a new password for <span className="font-mono text-text-primary">{resetPwFor.username}</span>.
              </p>

              <div>
                <label className="label">New password</label>
                <input
                  type="password"
                  value={resetPw.password}
                  onChange={e => setResetPw({ ...resetPw, password: e.target.value })}
                  className="input text-sm"
                  autoFocus
                />
              </div>

              <div>
                <label className="label">Confirm password</label>
                <input
                  type="password"
                  value={resetPw.confirm}
                  onChange={e => setResetPw({ ...resetPw, confirm: e.target.value })}
                  className="input text-sm"
                />
              </div>

              {resetMsg && (
                <p className={resetMsg.startsWith('Password reset') ? 'text-green text-sm' : 'text-red text-sm'}>{resetMsg}</p>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-border/30">
                <button type="button" onClick={() => setResetPwFor(null)} className="btn-secondary text-sm">Cancel</button>
                <button type="submit" disabled={!resetPw.password} className="btn-primary text-sm">Reset password</button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}
    </div>
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

      <TwoFactorSection />

      <ApiTokensSection />

      <button onClick={logout} className="btn-danger w-full">Logout</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2FA / TOTP (issue #18)
// ---------------------------------------------------------------------------

function TwoFactorSection() {
  const { user, setUser } = useAuthStore()
  const [setupData, setSetupData] = useState<{ secret: string; uri: string; qr_svg: string } | null>(null)
  const [code, setCode] = useState('')
  const [pwForDisable, setPwForDisable] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function startSetup() {
    setError(null)
    setMsg(null)
    setBusy(true)
    try {
      const data = await auth.totpSetup()
      setSetupData(data)
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await auth.totpVerify(code)
      setMsg('2FA enabled — you will be asked for a code on your next login.')
      setSetupData(null)
      setCode('')
      // Refresh current user so totp_enabled flips
      const me = await auth.me()
      setUser(me)
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await auth.totpDisable(pwForDisable)
      setMsg('2FA disabled.')
      setPwForDisable('')
      const me = await auth.me()
      setUser(me)
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-4 space-y-4">
      <div>
        <h2 className="text-sm font-medium text-text-primary">Two-Factor Authentication (TOTP)</h2>
        <p className="text-xs text-text-muted mt-1">
          Adds a second login factor — a 6-digit code from an authenticator app (1Password, Authy, Aegis, Google Authenticator, etc.).
        </p>
      </div>

      {error && <p className="text-red text-xs">{error}</p>}
      {msg && <p className="text-green text-xs">{msg}</p>}

      {user?.totp_enabled && !setupData ? (
        <form onSubmit={disable} className="space-y-3">
          <p className="text-sm text-green flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green inline-block" />
            2FA is enabled for this account.
          </p>
          <div>
            <label className="label">Confirm with current password to disable</label>
            <input
              type="password"
              value={pwForDisable}
              onChange={e => setPwForDisable(e.target.value)}
              className="input text-sm"
            />
          </div>
          <button type="submit" disabled={busy || !pwForDisable} className="btn-danger text-sm">Disable 2FA</button>
        </form>
      ) : setupData ? (
        <form onSubmit={verifyCode} className="space-y-3">
          <p className="text-xs text-text-muted">
            Scan this QR code with your authenticator, or enter the secret manually:
          </p>
          <div className="bg-white inline-block rounded p-2" dangerouslySetInnerHTML={{ __html: setupData.qr_svg }} />
          <p className="text-xs font-mono text-text-muted break-all">
            Secret: <span className="text-text-primary">{setupData.secret}</span>
          </p>
          <div>
            <label className="label">Enter the 6-digit code from the app</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              className="input text-base font-mono tracking-widest text-center w-40"
              autoFocus
              placeholder="000000"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || code.length !== 6} className="btn-primary text-sm">Enable 2FA</button>
            <button type="button" onClick={() => { setSetupData(null); setCode('') }} className="btn-secondary text-sm">Cancel</button>
          </div>
        </form>
      ) : (
        <button onClick={startSetup} disabled={busy} className="btn-primary text-sm">
          Set up 2FA
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// API tokens (issue #38)
// ---------------------------------------------------------------------------

function ApiTokensSection() {
  const [tokens, setTokens] = useState<import('@/api/client').ApiTokenSummary[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    try {
      setTokens(await auth.listTokens())
    } catch {
      setTokens([])
    }
  }

  useEffect(() => { reload() }, [])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setJustCreated(null)
    if (!newName.trim()) {
      setError('Name required')
      return
    }
    setCreating(true)
    try {
      const t = await auth.createToken(newName.trim())
      setJustCreated(t.token)
      setNewName('')
      await reload()
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  async function revoke(id: number) {
    if (!confirm('Revoke this token? Any scripts using it will stop working.')) return
    await auth.revokeToken(id)
    await reload()
  }

  function copyToken() {
    if (justCreated && navigator.clipboard) {
      navigator.clipboard.writeText(justCreated).catch(() => {})
    }
  }

  return (
    <div className="card p-4 space-y-4">
      <div>
        <h2 className="text-sm font-medium text-text-primary">API Tokens</h2>
        <p className="text-xs text-text-muted mt-1">
          Long-lived bearer tokens for automation. Use as <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>.
        </p>
      </div>

      {justCreated && (
        <div className="rounded border border-amber/40 bg-amber/5 p-3 space-y-2">
          <p className="text-xs text-amber font-medium">Copy this token now — it will not be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs text-text-primary bg-bg/50 p-2 rounded break-all select-all">{justCreated}</code>
            <button onClick={copyToken} className="btn-secondary text-xs">Copy</button>
          </div>
          <button onClick={() => setJustCreated(null)} className="text-xs text-text-muted hover:text-text-primary">Dismiss</button>
        </div>
      )}

      <form onSubmit={create} className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Token name (e.g. ci-bot)"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          className="input flex-1 text-sm"
          maxLength={100}
        />
        <button type="submit" disabled={creating || !newName.trim()} className="btn-primary text-sm">
          {creating ? '…' : 'Create'}
        </button>
      </form>
      {error && <p className="text-red text-xs">{error}</p>}

      {tokens.length === 0 ? (
        <p className="text-xs text-text-muted">No tokens yet.</p>
      ) : (
        <div className="space-y-1">
          {tokens.map(t => (
            <div key={t.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-border/30 last:border-0">
              <span className="font-mono text-text-primary truncate flex-1">{t.name}</span>
              <span className="font-mono text-text-muted">{t.prefix}…</span>
              <span className="text-text-muted/70 hidden sm:inline" title={t.last_used_at ?? 'never used'}>
                {t.last_used_at ? `used ${new Date(t.last_used_at).toLocaleDateString()}` : 'unused'}
              </span>
              <button onClick={() => revoke(t.id)} className="text-red/70 hover:text-red">Revoke</button>
            </div>
          ))}
        </div>
      )}
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
      a.download = `apt-ui-config-${date}.json`
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

// ---------------------------------------------------------------------------
// Infrastructure tab — Tailscale + apt-cacher-ng
// ---------------------------------------------------------------------------
function InfrastructureTab() {
  const [servers, setServers] = useState<AptCacheServer[]>([])
  const [form, setForm] = useState({ label: '', host: '', port: '3142' })
  const [formError, setFormError] = useState('')
  const [adding, setAdding] = useState(false)
  const [tsStatus, setTsStatus] = useState<TailscaleStatus | null>(null)

  const load = useCallback(async () => {
    const data = await aptcacheApi.list()
    setServers(data)
  }, [])

  const loadTs = useCallback(async () => {
    try {
      const s = await tailscaleApi.status()
      setTsStatus(s)
    } catch {
      setTsStatus({ available: false })
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    loadTs()
    const id = setInterval(loadTs, 30_000)
    return () => clearInterval(id)
  }, [loadTs])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.host.trim()) { setFormError('Host is required'); return }
    try {
      await aptcacheApi.add({
        label: form.label.trim() || form.host.trim(),
        host: form.host.trim(),
        port: parseInt(form.port) || 3142,
      })
      setForm({ label: '', host: '', port: '3142' })
      setAdding(false)
      load()
    } catch {
      setFormError('Failed to add server')
    }
  }

  async function handleToggle(s: AptCacheServer) {
    await aptcacheApi.update(s.id, { enabled: !s.enabled })
    load()
  }

  async function handleRemove(id: number) {
    await aptcacheApi.remove(id)
    load()
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Tailscale status */}
      <section className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-text-primary">Tailscale</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Tailscale VPN sidecar status. Enable via{' '}
              <span className="font-mono">docker-compose.tailscale.yml</span> overlay.
            </p>
          </div>
          {tsStatus?.available && (
            <button onClick={loadTs} className="btn-secondary text-xs">Refresh</button>
          )}
        </div>

        {!tsStatus && (
          <p className="text-xs text-text-muted">Loading…</p>
        )}

        {tsStatus && !tsStatus.available && (
          <div className="text-xs text-text-muted space-y-1">
            <p>Tailscale is not running. To enable it:</p>
            <pre className="bg-bg-tertiary rounded p-2 text-[11px] leading-5 overflow-x-auto">{
`docker compose -f docker-compose.yml \\
  -f docker-compose.tailscale.yml up -d`
            }</pre>
          </div>
        )}

        {tsStatus?.available && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-text-muted">State</span>
              <span className={`flex items-center gap-1 font-medium ${tsStatus.online ? 'text-green' : 'text-amber'}`}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${tsStatus.online ? 'bg-green' : 'bg-amber'}`} />
                {tsStatus.backend_state ?? (tsStatus.online ? 'Running' : 'Offline')}
              </span>
            </div>

            {tsStatus.hostname && (
              <div className="flex items-center gap-2">
                <span className="text-text-muted">Hostname</span>
                <span className="font-mono text-text-primary">{tsStatus.hostname}</span>
              </div>
            )}

            {tsStatus.ipv4 && (
              <div className="flex items-center gap-2">
                <span className="text-text-muted">IPv4</span>
                <span className="font-mono text-text-primary">{tsStatus.ipv4}</span>
              </div>
            )}

            {tsStatus.ipv6 && (
              <div className="flex items-center gap-2">
                <span className="text-text-muted">IPv6</span>
                <span className="font-mono text-text-primary truncate">{tsStatus.ipv6}</span>
              </div>
            )}

            {tsStatus.dns_name && (
              <div className="col-span-2 flex items-center gap-2">
                <span className="text-text-muted">DNS name</span>
                <a
                  href={`https://${tsStatus.dns_name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-text-primary hover:text-green transition-colors"
                >
                  {tsStatus.dns_name}
                </a>
                <span className="text-text-muted">(HTTPS if tailscale serve is enabled)</span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-text-primary">apt-cacher-ng Servers</h2>
            <p className="text-xs text-text-muted mt-0.5">Monitor your apt cache servers. Stats appear as a widget on the dashboard.</p>
          </div>
          <button onClick={() => setAdding(v => !v)} className="btn-secondary text-xs">{adding ? 'Cancel' : '+ Add'}</button>
        </div>

        {adding && (
          <form onSubmit={handleAdd} className="grid grid-cols-3 gap-2 items-end border-t border-border pt-4">
            <div>
              <label className="label">Label</label>
              <input className="input" placeholder="My apt cache" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
            </div>
            <div>
              <label className="label">Host / IP</label>
              <input className="input" placeholder="192.168.1.10" value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} />
            </div>
            <div>
              <label className="label">Port</label>
              <input className="input" type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} />
            </div>
            {formError && <p className="col-span-3 text-red text-xs">{formError}</p>}
            <div className="col-span-3 flex gap-2">
              <button type="submit" className="btn-primary text-xs">Add Server</button>
            </div>
          </form>
        )}

        {servers.length === 0 && !adding ? (
          <p className="text-xs text-text-muted">No apt-cacher-ng servers configured.</p>
        ) : (
          <div className="divide-y divide-border/40">
            {servers.map(s => (
              <div key={s.id} className="flex items-center gap-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-text-primary">{s.label}</p>
                  <p className="text-xs text-text-muted font-mono">{s.host}:{s.port}</p>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={() => handleToggle(s)}
                    className="w-3.5 h-3.5 accent-green"
                  />
                  Enabled
                </label>
                <button onClick={() => handleRemove(s.id)} className="text-text-muted hover:text-red transition-colors text-xs">Remove</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
