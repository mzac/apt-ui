import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { servers as serversApi, groups as groupsApi, config as configApi } from '@/api/client'
import type { Server, PackageInfo, UpdateHistory, ServerGroup } from '@/types'
import { createUpgradeWebSocket, createSelectiveUpgradeWebSocket, createAutoremoveWebSocket } from '@/api/client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import Convert from 'ansi-to-html'
import StatusDot from '@/components/StatusDot'
import PackageInstallModal from '@/components/PackageInstallModal'

const ansiConvert = new Convert({ escapeXML: true })

const TABS = ['Packages', 'Upgrade', 'Shell', 'History', 'Stats'] as const
type Tab = typeof TABS[number]

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>()
  const serverId = parseInt(id!)
  const location = useLocation()

  const [server, setServer] = useState<Server | null>(null)
  const [groupList, setGroupList] = useState<ServerGroup[]>([])
  const [tab, setTab] = useState<Tab>('Packages')
  const [checking, setChecking] = useState(false)
  const [rebootState, setRebootState] = useState<'idle' | 'confirm' | 'rebooting'>('idle')
  const [rebootMsg, setRebootMsg] = useState<string | null>(null)
  const [showEdit, setShowEdit] = useState(false)

  const load = useCallback(async () => {
    const [list, glist] = await Promise.all([serversApi.list(), groupsApi.list()])
    const s = list.find(x => x.id === serverId) || null
    setServer(s)
    setGroupList(glist)
  }, [serverId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if ((location.state as any)?.openEdit) {
      setShowEdit(true)
    }
  }, [location.state])

  // Auto-select tab from navigation state
  useEffect(() => {
    if ((location.state as any)?.tab) {
      setTab((location.state as any).tab as Tab)
    }
  }, [location.state])

  async function handleCheck() {
    setChecking(true)
    try { await serversApi.check(serverId); await load() }
    finally { setChecking(false) }
  }

  async function handleReboot() {
    setRebootState('rebooting')
    setRebootMsg(null)
    try {
      const res = await serversApi.reboot(serverId)
      setRebootMsg(res.success ? 'Reboot command sent.' : res.detail)
    } catch (err: unknown) {
      setRebootMsg((err as Error).message)
    } finally {
      setRebootState('idle')
    }
  }

  if (!server) return (
    <div className="flex items-center justify-center py-20 text-text-muted font-mono text-sm">Loading…</div>
  )

  const c = server.latest_check
  const statusVal = checking ? 'checking' : (!c ? 'unknown' : c.status === 'error' ? 'error' : c.packages_available > 0 ? 'updates_available' : 'up_to_date')

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-text-muted hover:text-text-primary text-sm">← Dashboard</Link>
          <StatusDot status={statusVal as any} size="md" />
          <div>
            <h1 className="font-mono text-lg text-text-primary">{server.name}</h1>
            <p className="text-text-muted text-xs font-mono">{server.hostname}:{server.ssh_port} · {server.username}</p>
          </div>
          {server.group_name && (
            <span
              className="badge text-xs"
              style={{ background: (server.group_color || '#3b82f6') + '22', color: server.group_color || '#3b82f6', border: `1px solid ${server.group_color || '#3b82f6'}44` }}
            >
              {server.group_name}
            </span>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleCheck} disabled={checking} className="btn-secondary text-xs">
            {checking ? 'Checking…' : 'Check Now'}
          </button>
          {c?.reboot_required && rebootState === 'idle' && (
            <button onClick={() => setRebootState('confirm')} className="btn-secondary text-xs text-amber border-amber/40 hover:border-amber/70">
              ↻ Reboot
            </button>
          )}
          {c?.reboot_required && rebootState === 'confirm' && (
            <>
              <span className="text-xs text-amber font-mono self-center">Reboot {server.name}?</span>
              <button onClick={handleReboot} className="btn-danger text-xs">Yes, reboot</button>
              <button onClick={() => setRebootState('idle')} className="btn-secondary text-xs">Cancel</button>
            </>
          )}
          {rebootState === 'rebooting' && (
            <span className="text-xs text-text-muted font-mono self-center">Sending reboot…</span>
          )}
          {rebootMsg && (
            <span className="text-xs text-text-muted font-mono self-center">{rebootMsg}</span>
          )}
          <button onClick={() => setShowEdit(v => !v)} className="btn-secondary text-xs">
            {showEdit ? 'Cancel Edit' : 'Edit'}
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {c && (
        <div className="flex flex-wrap gap-3 text-xs font-mono text-text-muted">
          {server.os_info && <span className="text-text-primary">{server.os_info}</span>}
          {c.packages_available > 0 && (
            <span className="text-amber">{c.packages_available} updates ({c.security_packages} security)</span>
          )}
          {c.reboot_required && <span className="text-amber">↻ reboot required</span>}
          {c.held_packages > 0 && <span className="text-blue">{c.held_packages} held packages</span>}
          {c.autoremove_count > 0 && <span className="text-amber">{c.autoremove_count} auto-removable</span>}
          {c.checked_at && <span>checked {new Date(c.checked_at).toLocaleString()}</span>}
        </div>
      )}

      {/* Edit form */}
      {showEdit && (
        <EditServerForm
          server={server}
          groupList={groupList}
          onSaved={() => { load(); setShowEdit(false) }}
          onCancel={() => setShowEdit(false)}
        />
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm transition-colors -mb-px border-b-2 ${
              tab === t ? 'border-green text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Packages' && <PackagesTab serverId={serverId} server={server} onRefresh={load} />}
      {tab === 'Upgrade' && <UpgradePanel serverId={serverId} server={server} onRefresh={load} />}
      {tab === 'Shell' && <SshShellPanelWrapper serverId={serverId} />}
      {tab === 'History' && <HistoryTab serverId={serverId} />}
      {tab === 'Stats' && <StatsTab serverId={serverId} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit server form
// ---------------------------------------------------------------------------
function EditServerForm({ server, groupList, onSaved, onCancel }: {
  server: Server
  groupList: ServerGroup[]
  onSaved: () => void
  onCancel: () => void
}) {
  const [editForm, setEditForm] = useState({
    name: server.name,
    hostname: server.hostname,
    username: server.username,
    ssh_port: String(server.ssh_port),
    group_id: server.group_id ? String(server.group_id) : '',
    is_enabled: server.is_enabled,
    tags: (server.tags || []).map(t => t.name).join(', '),
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setEditForm({
      name: server.name,
      hostname: server.hostname,
      username: server.username,
      ssh_port: String(server.ssh_port),
      group_id: server.group_id ? String(server.group_id) : '',
      is_enabled: server.is_enabled,
      tags: (server.tags || []).map(t => t.name).join(', '),
    })
  }, [server])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await serversApi.update(server.id, {
        name: editForm.name,
        hostname: editForm.hostname,
        username: editForm.username,
        ssh_port: parseInt(editForm.ssh_port) || 22,
        group_id: editForm.group_id ? parseInt(editForm.group_id) : null,
        is_enabled: editForm.is_enabled,
        tag_names: editForm.tags.split(',').map(t => t.trim()).filter(Boolean),
      })
      onSaved()
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card p-4 space-y-3">
      <h3 className="text-xs text-text-muted uppercase tracking-wide">Edit Server</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div>
          <label className="label">Display Name</label>
          <input
            className="input w-full text-sm"
            value={editForm.name}
            onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div>
          <label className="label">Hostname</label>
          <input
            className="input w-full text-sm"
            value={editForm.hostname}
            onChange={e => setEditForm(f => ({ ...f, hostname: e.target.value }))}
          />
        </div>
        <div>
          <label className="label">SSH User</label>
          <input
            className="input w-full text-sm"
            value={editForm.username}
            onChange={e => setEditForm(f => ({ ...f, username: e.target.value }))}
          />
        </div>
        <div>
          <label className="label">Port</label>
          <input
            className="input w-full text-sm"
            type="number"
            value={editForm.ssh_port}
            onChange={e => setEditForm(f => ({ ...f, ssh_port: e.target.value }))}
          />
        </div>
        <div>
          <label className="label">Group</label>
          <select
            className="input w-full text-sm"
            value={editForm.group_id}
            onChange={e => setEditForm(f => ({ ...f, group_id: e.target.value }))}
          >
            <option value="">None</option>
            {groupList.map(g => (
              <option key={g.id} value={String(g.id)}>{g.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Tags</label>
          <input
            type="text"
            className="input w-full text-xs"
            placeholder="tag1, tag2, tag3"
            value={editForm.tags}
            onChange={e => setEditForm(f => ({ ...f, tags: e.target.value }))}
          />
          <p className="text-xs text-text-muted mt-0.5">Comma-separated tags</p>
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={editForm.is_enabled}
              onChange={e => setEditForm(f => ({ ...f, is_enabled: e.target.checked }))}
              className="w-4 h-4 accent-green"
            />
            Enabled
          </label>
        </div>
      </div>
      {error && <p className="text-xs text-red font-mono">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleSave} disabled={saving} className="btn-primary text-sm">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Reboot heuristic — packages that typically require a restart
// ---------------------------------------------------------------------------
const REBOOT_PATTERNS = [
  /^linux-image/, /^linux-headers/, /^linux-modules/, /^linux-firmware/,
  /^proxmox-kernel/, /^pve-kernel/, /^raspberrypi-kernel/, /^rpi-/,
  /^libc6$/, /^libc-bin$/, /^libc-dev/, /^libc6-dev/,
  /^libssl/, /^openssl$/,
  /^systemd$/, /^systemd-sysv$/, /^udev$/, /^dbus$/,
  /^initramfs-tools/, /^linux-libc-dev/,
  /^libgcc-s/, /^gcc-[0-9]+-base/,
]
function likelyRequiresReboot(name: string): boolean {
  return REBOOT_PATTERNS.some(p => p.test(name))
}

// Packages tab
// ---------------------------------------------------------------------------
function PackagesTab({ serverId, server, onRefresh }: { serverId: number; server: Server; onRefresh: () => void }) {
  const [packages, setPackages] = useState<PackageInfo[]>([])
  const [held, setHeld] = useState<string[]>([])
  const [autoremove, setAutoremove] = useState<string[]>([])
  const [sortCol, setSortCol] = useState<'name' | 'security'>('security')
  const [filterSec, setFilterSec] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [upgradeModal, setUpgradeModal] = useState(false)
  const [allowPhased, setAllowPhased] = useState(false)
  const [selectedRemove, setSelectedRemove] = useState<Set<string>>(new Set())
  const [removeTarget, setRemoveTarget] = useState<string[] | null>(null)
  const [removeModal, setRemoveModal] = useState(false)
  const [showInstallModal, setShowInstallModal] = useState(false)

  const loadPackages = useCallback(() => {
    serversApi.packages(serverId).then(data => {
      setPackages(data.packages)
      setHeld(data.held)
      setAutoremove(data.autoremove ?? [])
      setSelected(new Set())
      setSelectedRemove(new Set())
    })
  }, [serverId])

  useEffect(() => { loadPackages() }, [loadPackages])

  const sorted = [...packages]
    .filter(p => !filterSec || p.is_security)
    .sort((a, b) => {
      if (sortCol === 'security') return (b.is_security ? 1 : 0) - (a.is_security ? 1 : 0)
      return a.name.localeCompare(b.name)
    })

  function toggleOne(name: string) {
    setSelected(s => {
      const n = new Set(s)
      n.has(name) ? n.delete(name) : n.add(name)
      return n
    })
  }

  function selectAll() { setSelected(new Set(sorted.map(p => p.name))) }
  function selectSecurity() { setSelected(new Set(sorted.filter(p => p.is_security).map(p => p.name))) }
  function clearSelection() { setSelected(new Set()) }

  const allChecked = sorted.length > 0 && sorted.every(p => selected.has(p.name))
  const someChecked = sorted.some(p => selected.has(p.name))

  return (
    <div className="space-y-4">
      {/* Install Package button — always visible */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowInstallModal(true)}
          className="btn-secondary text-xs"
        >
          + Install Package
        </button>
      </div>

      {packages.length === 0 ? (
        <p className="text-text-muted text-sm py-8 text-center">No pending updates.</p>
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            <select className="input w-auto text-xs py-1" value={sortCol} onChange={e => setSortCol(e.target.value as any)}>
              <option value="security">Sort: Security first</option>
              <option value="name">Sort: Name</option>
            </select>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <input type="checkbox" checked={filterSec} onChange={e => setFilterSec(e.target.checked)} className="w-3 h-3 accent-red" />
              Security only
            </label>
            <div className="flex gap-1 ml-2">
              <button onClick={selectAll} className="btn-secondary text-xs py-0.5">All</button>
              <button onClick={selectSecurity} className="btn-secondary text-xs py-0.5">Security</button>
              <button onClick={clearSelection} className="btn-secondary text-xs py-0.5">Clear</button>
            </div>
            <span className="text-xs text-text-muted ml-auto">{sorted.length} packages</span>
            <button
              onClick={() => { setSelected(new Set(packages.map(p => p.name))); setUpgradeModal(true) }}
              disabled={packages.length === 0}
              className="btn-amber text-xs"
            >
              Upgrade All ({packages.length})
            </button>
            {someChecked && (
              <button
                onClick={() => setUpgradeModal(true)}
                className="btn-amber text-xs"
              >
                Upgrade Selected ({selected.size})
              </button>
            )}
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-text-muted uppercase text-xs">
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={e => e.target.checked ? selectAll() : clearSelection()}
                      className="w-3 h-3 accent-green"
                    />
                  </th>
                  <th className="text-left px-3 py-2">Package</th>
                  <th className="text-left px-3 py-2">Current</th>
                  <th className="text-left px-3 py-2">Available</th>
                  <th className="text-left px-3 py-2">Repo</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => {
                  const reboot = likelyRequiresReboot(p.name)
                  return (
                  <tr
                    key={p.name}
                    onClick={() => toggleOne(p.name)}
                    className={`border-b border-border/30 cursor-pointer transition-colors
                      ${selected.has(p.name) ? 'bg-green/5 border-green/20' : p.is_security ? 'bg-red/5' : ''}
                      hover:bg-surface-2/60`}
                  >
                    <td className="px-3 py-1.5" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(p.name)}
                        onChange={() => toggleOne(p.name)}
                        className="w-3 h-3 accent-green"
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono">
                      {p.is_security && <span className="text-red mr-1" title="Security update">🔒</span>}
                      {reboot && <span className="text-amber mr-1" title="Likely requires reboot">↺</span>}
                      {p.name}
                      {p.is_phased && <span className="ml-1 text-text-muted">[phased]</span>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-text-muted">{p.current_version}</td>
                    <td className="px-3 py-1.5 font-mono text-text-primary">→ {p.available_version}</td>
                    <td className="px-3 py-1.5 font-mono text-text-muted text-xs">{p.repository}</td>
                    <td className="px-3 py-1.5 text-right" onClick={e => e.stopPropagation()}>
                      {(p.description || reboot) && (
                        <span className="relative group/info inline-block">
                          <span className="text-text-muted/50 hover:text-cyan cursor-default select-none text-xs font-mono">ⓘ</span>
                          <div className="absolute right-0 bottom-full mb-1 z-50 hidden group-hover/info:block w-72 pointer-events-none">
                            <div className="bg-surface border border-border rounded shadow-lg p-3 text-xs space-y-1.5">
                              <p className="font-mono font-medium text-text-primary">{p.name}</p>
                              {p.description && <p className="text-text-muted leading-snug">{p.description}</p>}
                              <div className="border-t border-border/50 pt-1.5 space-y-0.5 font-mono">
                                <p className="text-text-muted">{p.current_version} <span className="text-text-muted/50">→</span> <span className="text-green">{p.available_version}</span></p>
                                <p className="text-text-muted/70">{p.repository}</p>
                                {p.is_security && <p className="text-red">🔒 Security update</p>}
                                {p.is_phased && <p className="text-text-muted">Phased rollout</p>}
                                {reboot && <p className="text-amber">↺ Likely requires reboot</p>}
                              </div>
                            </div>
                          </div>
                        </span>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {held.length > 0 && (
        <div>
          <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">Held Packages ({held.length})</h3>
          <div className="card p-3 flex flex-wrap gap-1">
            {held.map(h => (
              <span key={h} className="badge bg-blue/10 text-blue border border-blue/30 text-xs font-mono">{h}</span>
            ))}
          </div>
        </div>
      )}

      {autoremove.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs font-mono text-amber">
              {autoremove.length} package{autoremove.length !== 1 ? 's' : ''} can be auto-removed
            </span>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setSelectedRemove(new Set(autoremove))}
                className="btn-secondary text-xs py-0.5"
              >
                Select All
              </button>
              {selectedRemove.size > 0 && (
                <button
                  onClick={() => { setRemoveTarget([...selectedRemove]); setRemoveModal(true) }}
                  className="btn-danger text-xs py-0.5"
                >
                  Remove Selected ({selectedRemove.size})
                </button>
              )}
              <button
                onClick={() => { setRemoveTarget(null); setRemoveModal(true) }}
                className="btn-secondary text-xs py-0.5 text-amber border-amber/40"
              >
                Remove All
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {autoremove.map(pkg => (
                <tr
                  key={pkg}
                  className="border-b border-border/50 hover:bg-surface-2/50 cursor-pointer"
                  onClick={() => setSelectedRemove(s => {
                    const n = new Set(s)
                    n.has(pkg) ? n.delete(pkg) : n.add(pkg)
                    return n
                  })}
                >
                  <td className="px-3 py-1.5 w-8">
                    <input
                      type="checkbox"
                      readOnly
                      checked={selectedRemove.has(pkg)}
                      className="w-4 h-4 accent-green pointer-events-none"
                    />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-text-muted">{pkg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {upgradeModal && (
        <SelectiveUpgradeModal
          serverId={serverId}
          packages={[...selected]}
          allowPhased={allowPhased}
          onClose={() => { setUpgradeModal(false); loadPackages(); onRefresh() }}
        />
      )}

      {removeModal && (
        <AutoremoveModal
          serverId={serverId}
          packages={removeTarget}
          onClose={() => { setRemoveModal(false); setRemoveTarget(null); loadPackages(); onRefresh() }}
        />
      )}

      {showInstallModal && (
        <PackageInstallModal
          serverId={serverId}
          serverName={server.name}
          onClose={() => { setShowInstallModal(false); loadPackages(); onRefresh() }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Selective upgrade modal
// ---------------------------------------------------------------------------
function SelectiveUpgradeModal({ serverId, packages, allowPhased, onClose }: {
  serverId: number
  packages: string[]
  allowPhased: boolean
  onClose: () => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [done, setDone] = useState(false)
  const [phasedOpt, setPhasedOpt] = useState(allowPhased)
  const [started, setStarted] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => { wsRef.current?.close() }, [])
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
  }, [lines])

  function start() {
    setStarted(true)
    setLines([])
    const ws = createSelectiveUpgradeWebSocket(
      serverId,
      { packages, allow_phased: phasedOpt },
      (msg) => {
        if (msg.type === 'output') setLines(l => [...l, msg.data as string])
        else if (msg.type === 'status') setLines(l => [...l, `\x1b[36m[${msg.data}]\x1b[0m\n`])
        else if (msg.type === 'error') setLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
        else if (msg.type === 'complete') {
          const d = msg.data as { success: boolean; packages_upgraded: number }
          setLines(l => [...l, `\x1b[${d.success ? '32' : '31'}m\n[complete] ${d.success ? '✓' : '✗'} ${d.packages_upgraded} packages upgraded\x1b[0m\n`])
        }
      },
      () => { setDone(true); window.dispatchEvent(new CustomEvent('apt:refresh')) },
    )
    wsRef.current = ws
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Upgrade Selected Packages</h2>
          <button onClick={onClose} className="text-text-muted hover:text-red">✕</button>
        </div>

        {!started ? (
          <div className="p-4 space-y-4">
            <div className="card p-3 max-h-48 overflow-y-auto">
              {packages.map(p => (
                <div key={p} className="font-mono text-xs text-text-muted py-0.5">{p}</div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-text-muted">
              <input type="checkbox" checked={phasedOpt} onChange={e => setPhasedOpt(e.target.checked)} className="w-4 h-4 accent-green" />
              Allow phased updates
            </label>
            <div className="flex gap-2">
              <button onClick={start} className="btn-amber">Upgrade {packages.length} package{packages.length !== 1 ? 's' : ''}</button>
              <button onClick={onClose} className="btn-secondary">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col p-4 gap-3 min-h-0">
            <div
              ref={termRef}
              className="flex-1 overflow-y-auto bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary"
              style={{ minHeight: '200px' }}
            >
              {lines.map((line, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
              ))}
              {!done && <span className="text-cyan animate-pulse">▋</span>}
            </div>
            {done && <button onClick={onClose} className="btn-primary">Done</button>}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Autoremove modal
// ---------------------------------------------------------------------------
function AutoremoveModal({ serverId, packages, onClose }: {
  serverId: number
  packages: string[] | null  // null = remove all autoremovable packages
  onClose: () => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [done, setDone] = useState(false)
  const [started, setStarted] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => { wsRef.current?.close() }, [])
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
  }, [lines])

  function start() {
    setStarted(true)
    setLines([])
    const ws = createAutoremoveWebSocket(
      serverId,
      { packages },
      (msg) => {
        if (msg.type === 'output') setLines(l => [...l, msg.data as string])
        else if (msg.type === 'status') setLines(l => [...l, `\x1b[36m[${msg.data}]\x1b[0m\n`])
        else if (msg.type === 'error') setLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
        else if (msg.type === 'complete') {
          const d = msg.data as { success: boolean }
          setLines(l => [...l, `\x1b[${d.success ? '32' : '31'}m\n[complete] ${d.success ? '✓ Autoremove successful' : '✗ Autoremove failed'}\x1b[0m\n`])
        }
      },
      () => { setDone(true); window.dispatchEvent(new CustomEvent('apt:refresh')) },
    )
    wsRef.current = ws
  }

  const label = packages === null
    ? 'Remove all auto-removable packages'
    : `Remove ${packages.length} selected package${packages.length !== 1 ? 's' : ''}`

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Autoremove Packages</h2>
          <button onClick={onClose} className="text-text-muted hover:text-red">✕</button>
        </div>

        {!started ? (
          <div className="p-4 space-y-4">
            <p className="text-sm text-text-muted">{label}</p>
            {packages !== null && packages.length > 0 && (
              <div className="card p-3 max-h-48 overflow-y-auto">
                {packages.map(p => (
                  <div key={p} className="font-mono text-xs text-text-muted py-0.5">{p}</div>
                ))}
              </div>
            )}
            <p className="text-xs text-amber">
              ⚠️ These packages will be permanently removed from the server.
            </p>
            <div className="flex gap-2">
              <button onClick={start} className="btn-danger">{label}</button>
              <button onClick={onClose} className="btn-secondary">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col p-4 gap-3 min-h-0">
            <div
              ref={termRef}
              className="flex-1 overflow-y-auto bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary"
              style={{ minHeight: '200px' }}
            >
              {lines.map((line, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
              ))}
              {!done && <span className="text-cyan animate-pulse">▋</span>}
            </div>
            {done && <button onClick={onClose} className="btn-primary">Done</button>}
          </div>
        )}
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Shell panel wrapper (checks feature flag)
// ---------------------------------------------------------------------------
function SshShellPanelWrapper({ serverId }: { serverId: number }) {
  const [terminalEnabled, setTerminalEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    configApi.features().then(f => setTerminalEnabled(f.enable_terminal)).catch(() => setTerminalEnabled(false))
  }, [])

  if (terminalEnabled === null) {
    return <div className="text-text-muted text-sm py-8 text-center font-mono">Loading…</div>
  }

  if (!terminalEnabled) {
    return (
      <div className="card p-6 text-center space-y-2">
        <p className="text-text-muted text-sm">Shell access is disabled.</p>
        <p className="text-text-muted text-xs font-mono">Set <span className="text-cyan">ENABLE_TERMINAL=true</span> in your docker-compose.yml to enable it.</p>
      </div>
    )
  }

  return <SshShellPanel serverId={serverId} />
}

// ---------------------------------------------------------------------------
// Upgrade panel (extracted from old TerminalTab body)
// ---------------------------------------------------------------------------
function UpgradePanel({ serverId, server, onRefresh }: { serverId: number; server: Server; onRefresh: () => void }) {
  const [action, setAction] = useState('upgrade')
  const [allowPhased, setAllowPhased] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => { wsRef.current?.close() }, [])
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
  }, [lines])

  function startUpgrade() {
    setLines([])
    setDone(false)
    setRunning(true)

    const ws = createUpgradeWebSocket(serverId, { action, allow_phased: allowPhased }, (msg) => {
      if (msg.type === 'output') {
        setLines(l => [...l, msg.data as string])
      } else if (msg.type === 'status') {
        setLines(l => [...l, `\x1b[36m[status] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'error') {
        setLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'complete') {
        const data = msg.data as { success: boolean; packages_upgraded: number }
        setLines(l => [...l, `\x1b[${data.success ? '32' : '31'}m\n[complete] ${data.success ? '✓ Upgrade successful' : '✗ Upgrade failed'} — ${data.packages_upgraded} packages\x1b[0m\n`])
      }
    }, () => {
      setRunning(false)
      setDone(true)
      onRefresh()
      window.dispatchEvent(new CustomEvent('apt:refresh'))
    })
    wsRef.current = ws
  }

  const hasUpdates = (server.latest_check?.packages_available ?? 0) > 0

  return (
    <div className="space-y-3">
      {!running && (
        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="label">Mode</label>
              <div className="flex gap-3">
                {['upgrade', 'dist-upgrade'].map(m => (
                  <label key={m} className="flex items-center gap-1.5 text-sm text-text-muted cursor-pointer">
                    <input type="radio" name="mode" value={m} checked={action === m} onChange={() => setAction(m)} className="accent-green" />
                    <span className="font-mono">{m}</span>
                  </label>
                ))}
              </div>
              {action === 'dist-upgrade' && (
                <p className="text-xs text-amber mt-1">⚠️ dist-upgrade may remove or install packages.</p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-text-muted">
              <input type="checkbox" checked={allowPhased} onChange={e => setAllowPhased(e.target.checked)} className="w-4 h-4 accent-green" />
              Allow phased updates
            </label>
            <button
              onClick={startUpgrade}
              disabled={!hasUpdates}
              className="btn-amber"
              title={!hasUpdates ? 'No updates available' : ''}
            >
              Run Upgrade
            </button>
          </div>
        </div>
      )}

      <div
        ref={termRef}
        className="bg-bg border border-border rounded p-3 font-mono text-xs text-text-primary overflow-y-auto"
        style={{ minHeight: '300px', maxHeight: '60vh' }}
      >
        {lines.length === 0 && !running && (
          <span className="text-text-muted">Terminal output will appear here when an upgrade runs.</span>
        )}
        {lines.map((line, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
        ))}
        {running && <span className="text-cyan animate-pulse">▋</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SSH Shell panel
// ---------------------------------------------------------------------------
function SshShellPanel({ serverId }: { serverId: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<any>(null)   // Terminal instance
  const fitRef = useRef<any>(null)    // FitAddon instance
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      wsRef.current?.close()
      termRef.current?.dispose()
    }
  }, [])

  async function connect() {
    if (!containerRef.current) return
    setStatus('connecting')
    setError(null)

    // Dispose any existing session
    wsRef.current?.close()
    if (termRef.current) {
      termRef.current.dispose()
      termRef.current = null
    }

    // Dynamically import xterm to avoid SSR issues
    const { Terminal } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')


    const term = new Terminal({
      theme: {
        background: '#0f1117',
        foreground: '#e2e8f0',
        cursor: '#22c55e',
        selectionBackground: '#22c55e44',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const ro = new ResizeObserver(() => fitRef.current?.fit())
    ro.observe(containerRef.current)

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/shell/${serverId}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }))
      setStatus('connected')
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'output') term.write(msg.data)
        else if (msg.type === 'error') {
          term.write(`\r\n\x1b[31m[error] ${msg.data}\x1b[0m\r\n`)
          setError(msg.data)
        }
      } catch {}
    }

    ws.onclose = () => {
      setStatus('disconnected')
      termRef.current?.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n')
    }

    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })
  }

  function disconnect() {
    wsRef.current?.close()
    setStatus('disconnected')
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {status === 'connected' ? (
          <button onClick={disconnect} className="btn-secondary text-xs">Disconnect</button>
        ) : (
          <button onClick={connect} disabled={status === 'connecting'} className="btn-secondary text-xs">
            {status === 'connecting' ? 'Connecting…' : status === 'disconnected' ? 'Reconnect' : 'Connect Shell'}
          </button>
        )}
        {status === 'connected' && <span className="text-xs text-green font-mono">● connected</span>}
        {status === 'disconnected' && <span className="text-xs text-text-muted font-mono">● disconnected</span>}
        {error && <span className="text-xs text-red font-mono truncate max-w-xs">{error}</span>}
      </div>
      {status === 'idle' && (
        <div className="bg-bg border border-border rounded flex items-center justify-center text-text-muted text-sm font-mono" style={{ height: '200px' }}>
          Click "Connect Shell" to open an interactive SSH terminal
        </div>
      )}
      <div
        ref={containerRef}
        className="rounded border border-border overflow-hidden"
        style={{ height: '480px', display: status === 'idle' ? 'none' : 'block' }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------
function HistoryTab({ serverId }: { serverId: number }) {
  const [items, setItems] = useState<UpdateHistory[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    serversApi.history(serverId, page).then(data => {
      setItems(data.items)
      setTotal(data.total)
    })
  }, [serverId, page])

  if (items.length === 0) return <p className="text-text-muted text-sm py-8 text-center">No upgrade history.</p>

  return (
    <div className="space-y-2">
      {items.map(h => (
        <div key={h.id} className="card overflow-hidden">
          <button
            className="w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-surface-2/50 transition-colors"
            onClick={() => setExpanded(expanded === h.id ? null : h.id)}
          >
            <div className="flex items-center gap-3 text-sm">
              <span className={h.status === 'success' ? 'text-green' : h.status === 'error' ? 'text-red' : 'text-cyan'}>
                {h.status === 'success' ? '✓' : h.status === 'error' ? '✗' : '⚙'}
              </span>
              <span className="font-mono">{h.action}</span>
              <span className="text-text-muted">{new Date(h.started_at).toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-text-muted">
              {h.packages_upgraded && <span>{h.packages_upgraded.length} pkgs</span>}
              {h.initiated_by && <span className="font-mono">{h.initiated_by}</span>}
              {h.phased_updates && <span className="badge bg-blue/10 text-blue border border-blue/30">phased</span>}
              <span>{expanded === h.id ? '▲' : '▼'}</span>
            </div>
          </button>
          {expanded === h.id && h.log_output && (
            <div className="border-t border-border bg-bg px-3 py-2 font-mono text-xs text-text-primary overflow-x-auto max-h-64 overflow-y-auto">
              <pre className="whitespace-pre-wrap">{h.log_output}</pre>
            </div>
          )}
        </div>
      ))}

      {total > 20 && (
        <div className="flex gap-2 justify-center text-sm">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="btn-secondary">Prev</button>
          <span className="text-text-muted self-center">{page} / {Math.ceil(total / 20)}</span>
          <button disabled={page >= Math.ceil(total / 20)} onClick={() => setPage(p => p + 1)} className="btn-secondary">Next</button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stats tab
// ---------------------------------------------------------------------------
function StatsTab({ serverId }: { serverId: number }) {
  const [data, setData] = useState<{ date: string; packages: number; security: number }[]>([])

  useEffect(() => {
    // Build trend from history checks — fetch multiple pages
    serversApi.history(serverId, 1).then(result => {
      const points = result.items
        .filter(h => h.status === 'success')
        .slice(0, 30)
        .reverse()
        .map(h => ({
          date: new Date(h.started_at).toLocaleDateString(),
          packages: h.packages_upgraded?.length ?? 0,
          security: 0,
        }))
      setData(points)
    })
  }, [serverId])

  if (data.length === 0) return <p className="text-text-muted text-sm py-8 text-center">No stats available yet.</p>

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="text-xs text-text-muted uppercase tracking-wide mb-4">Packages upgraded per run (last 30)</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 11 }} />
            <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: '#1a1d27', border: '1px solid #2e3347', borderRadius: '4px', fontSize: '12px' }}
              labelStyle={{ color: '#e5e7eb' }}
            />
            <Line type="monotone" dataKey="packages" stroke="#22c55e" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
