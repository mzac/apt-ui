import { useState, useEffect, useCallback, useRef } from 'react'
import { servers as serversApi, templates as templatesApi, createTemplateApplyWebSocket } from '@/api/client'
import type { Template, TemplatePackage, Server } from '@/types'
import Convert from 'ansi-to-html'

const ansiConvert = new Convert({ escapeXML: true })

interface ServerProgress {
  status: 'pending' | 'running' | 'done' | 'error'
  lines: string[]
}

export default function Templates() {
  const [templateList, setTemplateList] = useState<Template[]>([])
  const [selected, setSelected] = useState<Template | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showApply, setShowApply] = useState(false)

  const selectedIdRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    const t = await templatesApi.list()
    setTemplateList(t)
    // Sync selected template without adding it as a dependency
    if (selectedIdRef.current !== null) {
      const updated = t.find(x => x.id === selectedIdRef.current)
      if (updated) setSelected(updated)
    }
  }, [])

  // Keep ref in sync with state
  useEffect(() => { selectedIdRef.current = selected?.id ?? null }, [selected])

  useEffect(() => { load() }, [load])

  async function handleDelete(id: number) {
    if (!confirm('Delete this template?')) return
    await templatesApi.remove(id)
    if (selected?.id === id) setSelected(null)
    load()
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-mono text-text-primary">Package Templates</h1>
        <button className="btn-primary text-sm" onClick={() => setShowCreate(true)}>+ New Template</button>
      </div>

      <div className="flex gap-4 flex-col md:flex-row">
        {/* Left: template list */}
        <div className="w-full md:w-64 shrink-0 space-y-2">
          {templateList.length === 0 && (
            <p className="text-text-muted text-sm text-center py-8">No templates yet.</p>
          )}
          {templateList.map(t => (
            <div
              key={t.id}
              onClick={() => setSelected(t)}
              className={`card p-3 cursor-pointer transition-colors ${selected?.id === t.id ? 'border-green/50 bg-green/5' : 'hover:border-text-muted'}`}
            >
              <div className="font-mono text-sm text-text-primary">{t.name}</div>
              {t.description && <div className="text-xs text-text-muted truncate mt-0.5">{t.description}</div>}
              <div className="text-xs text-text-muted mt-1">{t.packages.length} package{t.packages.length !== 1 ? 's' : ''}</div>
            </div>
          ))}
        </div>

        {/* Right: template detail */}
        <div className="flex-1">
          {selected ? (
            <TemplateDetail
              template={selected}
              onRefresh={load}
              onDelete={() => handleDelete(selected.id)}
              onApply={() => setShowApply(true)}
            />
          ) : (
            <div className="card p-8 text-center text-text-muted text-sm">
              Select a template to view details
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateTemplateModal
          onClose={() => setShowCreate(false)}
          onCreated={t => { setShowCreate(false); load(); setSelected(t) }}
        />
      )}

      {showApply && selected && (
        <ApplyTemplateModal
          template={selected}
          onClose={() => setShowApply(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Template detail panel
// ---------------------------------------------------------------------------
function TemplateDetail({
  template,
  onRefresh,
  onDelete,
  onApply,
}: {
  template: Template
  onRefresh: () => void
  onDelete: () => void
  onApply: () => void
}) {
  const [editMode, setEditMode] = useState(false)
  const [editForm, setEditForm] = useState({ name: template.name, description: template.description || '' })
  const [newPkg, setNewPkg] = useState('')
  const [newPkgNotes, setNewPkgNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await templatesApi.update(template.id, editForm)
      setEditMode(false)
      onRefresh()
    } finally {
      setSaving(false)
    }
  }

  async function handleAddPkg(e: React.FormEvent) {
    e.preventDefault()
    if (!newPkg.trim()) return
    await templatesApi.addPackage(template.id, { package_name: newPkg.trim(), notes: newPkgNotes.trim() || undefined })
    setNewPkg('')
    setNewPkgNotes('')
    onRefresh()
  }

  async function handleRemovePkg(pkg: TemplatePackage) {
    await templatesApi.removePackage(template.id, pkg.id)
    onRefresh()
  }

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        {editMode ? (
          <div className="flex-1 space-y-2">
            <input
              className="input w-full"
              value={editForm.name}
              onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Template name"
            />
            <input
              className="input w-full text-sm"
              value={editForm.description}
              onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Description (optional)"
            />
            <div className="flex gap-2">
              <button onClick={handleSave} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button>
              <button onClick={() => setEditMode(false)} className="btn-secondary text-sm">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex-1">
            <h2 className="font-mono text-base text-text-primary">{template.name}</h2>
            {template.description && <p className="text-sm text-text-muted mt-1">{template.description}</p>}
          </div>
        )}
        <div className="flex gap-2 shrink-0">
          {!editMode && (
            <>
              <button onClick={onApply} className="btn-primary text-sm">Apply to Servers</button>
              <button onClick={() => setEditMode(true)} className="btn-secondary text-sm">Edit</button>
              <button onClick={onDelete} className="btn-danger text-sm">Delete</button>
            </>
          )}
        </div>
      </div>

      {/* Package list */}
      <div>
        <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">Packages ({template.packages.length})</h3>
        {template.packages.length === 0 && (
          <p className="text-sm text-text-muted">No packages yet. Add one below.</p>
        )}
        <div className="space-y-1">
          {template.packages.map(pkg => (
            <div key={pkg.id} className="flex items-center justify-between px-3 py-2 bg-surface-2 rounded border border-border">
              <div>
                <span className="font-mono text-sm text-text-primary">{pkg.package_name}</span>
                {pkg.notes && <span className="text-xs text-text-muted ml-2">{pkg.notes}</span>}
              </div>
              <button
                onClick={() => handleRemovePkg(pkg)}
                className="text-text-muted hover:text-red text-sm ml-2"
              >✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* Add package form */}
      <form onSubmit={handleAddPkg} className="flex gap-2 items-end flex-wrap">
        <div>
          <label className="label">Package name</label>
          <input
            className="input w-48"
            placeholder="e.g. htop"
            value={newPkg}
            onChange={e => setNewPkg(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Notes (optional)</label>
          <input
            className="input w-48"
            placeholder="reason / notes"
            value={newPkgNotes}
            onChange={e => setNewPkgNotes(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-secondary text-sm">Add Package</button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create template modal
// ---------------------------------------------------------------------------
function CreateTemplateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (t: Template) => void
}) {
  const [form, setForm] = useState({ name: '', description: '' })
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const t = await templatesApi.create({ name: form.name, description: form.description || undefined })
      onCreated(t)
    } catch (err: unknown) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-sm p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">New Template</h2>
          <button onClick={onClose} className="text-text-muted hover:text-red">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="label">Name</label>
            <input
              className="input w-full"
              required
              placeholder="e.g. base-tools"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Description (optional)</label>
            <input
              className="input w-full"
              placeholder="What this template installs"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
          {error && <p className="text-red text-xs">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary">Create</button>
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Apply template modal
// ---------------------------------------------------------------------------
function ApplyTemplateModal({ template, onClose }: { template: Template; onClose: () => void }) {
  const [serverList, setServerList] = useState<Server[]>([])
  const [selectedServers, setSelectedServers] = useState<Set<number>>(new Set())
  const [started, setStarted] = useState(false)
  const [done, setDone] = useState(false)
  const [progress, setProgress] = useState<Record<number, ServerProgress>>({})
  const [filterSrv, setFilterSrv] = useState<number | null>(null)

  useEffect(() => {
    serversApi.list().then(s => setServerList(s.filter(x => x.is_enabled)))
  }, [])

  function toggleServer(id: number) {
    setSelectedServers(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function start() {
    if (selectedServers.size === 0) return
    const ids = Array.from(selectedServers)
    setStarted(true)
    const initial: Record<number, ServerProgress> = {}
    ids.forEach(id => { initial[id] = { status: 'pending', lines: [] } })
    setProgress(initial)

    createTemplateApplyWebSocket(template.id, ids, (msg) => {
      const sid = msg.server_id as number
      if (!sid) return
      if (msg.type === 'output') {
        setProgress(p => ({ ...p, [sid]: { ...p[sid], status: 'running', lines: [...(p[sid]?.lines || []), msg.data as string] } }))
      } else if (msg.type === 'complete') {
        const d = msg.data as { success: boolean }
        setProgress(p => ({ ...p, [sid]: { ...p[sid], status: d.success ? 'done' : 'error' } }))
      } else if (msg.type === 'error') {
        setProgress(p => ({ ...p, [sid]: { ...p[sid], status: 'error', lines: [...(p[sid]?.lines || []), msg.data as string] } }))
      }
    }, () => setDone(true))
  }

  const selectedServerObjs = serverList.filter(s => selectedServers.has(s.id))
  const statusIcon = (s: ServerProgress['status']) => ({ pending: '⏳', running: '⚙️', done: '✓', error: '✗' }[s])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Apply Template: {template.name}</h2>
          {(!started || done) && (
            <button onClick={onClose} className="text-text-muted hover:text-red">✕</button>
          )}
        </div>

        {!started ? (
          <div className="p-4 space-y-4 overflow-y-auto">
            <p className="text-sm text-text-muted">
              Packages: <span className="font-mono text-text-primary">{template.packages.map(p => p.package_name).join(', ')}</span>
            </p>
            <div>
              <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">Select Servers</h3>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {serverList.map(s => (
                  <label key={s.id} className="flex items-center gap-2 px-3 py-2 rounded bg-surface-2 border border-border cursor-pointer hover:border-text-muted transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedServers.has(s.id)}
                      onChange={() => toggleServer(s.id)}
                      className="w-4 h-4 accent-green"
                    />
                    <span className="font-mono text-sm">{s.name}</span>
                    <span className="text-xs text-text-muted">{s.hostname}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={start} disabled={selectedServers.size === 0} className="btn-primary">
                Apply to {selectedServers.size} server{selectedServers.size !== 1 ? 's' : ''}
              </button>
              <button onClick={onClose} className="btn-secondary">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col p-4 gap-3">
            {/* Server status chips */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFilterSrv(null)}
                className={`px-2 py-1 rounded text-xs font-mono border transition-colors ${filterSrv === null ? 'bg-surface border-text-muted text-text-primary' : 'border-border text-text-muted hover:border-text-muted'}`}
              >All</button>
              {selectedServerObjs.map(s => {
                const p = progress[s.id]
                const active = filterSrv === s.id
                const borderColor = p?.status === 'done' ? '#22c55e' : p?.status === 'error' ? '#ef4444' : p?.status === 'running' ? '#06b6d4' : '#374151'
                return (
                  <button
                    key={s.id}
                    onClick={() => setFilterSrv(active ? null : s.id)}
                    className={`px-2 py-1 rounded text-xs font-mono border transition-colors flex items-center gap-1 ${active ? 'bg-surface text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
                    style={{ borderColor: active ? borderColor : undefined }}
                  >
                    <span>{statusIcon(p?.status || 'pending')}</span>
                    <span className="truncate max-w-[100px]">{s.name}</span>
                  </button>
                )
              })}
            </div>
            <div className="flex-1 overflow-y-auto bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary min-h-0" style={{ maxHeight: '40vh' }}>
              {selectedServerObjs.flatMap(s => {
                if (filterSrv !== null && filterSrv !== s.id) return []
                return (progress[s.id]?.lines || []).map((line, i) => (
                  <div key={`${s.id}-${i}`}>
                    {filterSrv === null && <span className="text-text-muted">[{s.name}] </span>}
                    <span dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
                  </div>
                ))
              })}
            </div>
            {done && (
              <button onClick={onClose} className="btn-primary">Done</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
