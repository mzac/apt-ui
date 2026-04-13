import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { servers as serversApi, groups as groupsApi, tags as tagsApi, config as configApi } from '@/api/client'
import type { DpkgLogEntry, AptRepoFile } from '@/api/client'
import type { Server, PackageInfo, UpdateHistory, ServerGroup, Tag } from '@/types'
import { useJobStore } from '@/hooks/useJobStore'
import { createUpgradeWebSocket, createSelectiveUpgradeWebSocket, createAutoremoveWebSocket, createAptUpdateWebSocket, createAutoSecurityUpdatesWebSocket, createAptProxyWebSocket, createEepromUpdateWebSocket, createDryRunWebSocket, createAptReposTestWebSocket, createPveUpgradeWebSocket } from '@/api/client'
import DebInstallModal from '@/components/DebInstallModal'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import Convert from 'ansi-to-html'
import StatusDot from '@/components/StatusDot'
import PackageInstallModal from '@/components/PackageInstallModal'

const ansiConvert = new Convert({ escapeXML: true })

// Handle \r (carriage return) in terminal output so apt progress lines
// overwrite in place rather than accumulating into one long concatenated line.
// \r\n (Windows / dpkg line endings) is treated as a plain newline so that
// lines like "Preparing to unpack ...\r\n" are not silently dropped.
function applyChunk(lines: string[], chunk: string): string[] {
  const result = [...lines]
  let current = result.length > 0 ? result.pop()! : ''
  let i = 0
  while (i < chunk.length) {
    const ch = chunk[i]
    if (ch === '\n') {
      result.push(current)
      current = ''
      i++
    } else if (ch === '\r') {
      if (chunk[i + 1] === '\n') {
        // \r\n — treat as a regular newline, preserve content
        result.push(current)
        current = ''
        i += 2
      } else {
        // bare \r — carriage return, overwrite current line
        current = ''
        i++
      }
    } else {
      // Scan forward to the next control character
      let end = i + 1
      while (end < chunk.length && chunk[end] !== '\r' && chunk[end] !== '\n') end++
      current += chunk.slice(i, end)
      i = end
    }
  }
  result.push(current)
  return result
}

const TABS = ['Packages', 'Upgrade', 'Apt Repos', 'History', 'dpkg Log', 'Stats', 'Shell'] as const
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
  const alwaysShowReboot = localStorage.getItem('dashboard:alwaysShowReboot') === 'true'
  const [rebootMsg, setRebootMsg] = useState<string | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const { addJob, updateJob } = useJobStore()

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
    const jobId = `check-${serverId}`
    setChecking(true)
    addJob({ id: jobId, type: 'check', label: `Check ${server?.name ?? serverId}`, status: 'running', link: `/servers/${serverId}`, startedAt: Date.now() })
    try {
      await serversApi.check(serverId)
      updateJob(jobId, { status: 'complete', completedAt: Date.now() })
      await load()
    } catch {
      updateJob(jobId, { status: 'error', completedAt: Date.now() })
    } finally {
      setChecking(false)
    }
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
          {(c?.reboot_required || alwaysShowReboot) && rebootState === 'idle' && (
            <button onClick={() => setRebootState('confirm')} className="btn-secondary text-xs text-amber border-amber/40 hover:border-amber/70">
              ↻ Reboot
            </button>
          )}
          {(c?.reboot_required || alwaysShowReboot) && rebootState === 'confirm' && (
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
          {server.last_apt_update && (
            <span title="Last time apt-get update was run on this server">
              apt index: {new Date(server.last_apt_update).toLocaleString()}
            </span>
          )}
          {server.apt_proxy && (
            <span className="text-cyan" title={`apt HTTP proxy: ${server.apt_proxy}`}>⚡ proxy: {server.apt_proxy}</span>
          )}
        </div>
      )}
      {server.notes && (
        <div className="text-xs text-text-muted font-mono bg-surface-2 border border-border rounded px-3 py-2 whitespace-pre-wrap">
          📝 {server.notes}
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
      {tab === 'dpkg Log' && <DpkgLogTab serverId={serverId} />}
      {tab === 'Apt Repos' && <AptReposTab serverId={serverId} />}
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
  const [tagList, setTagList] = useState<Tag[]>([])
  const [editForm, setEditForm] = useState({
    name: server.name,
    hostname: server.hostname,
    username: server.username,
    ssh_port: String(server.ssh_port),
    is_enabled: server.is_enabled,
    group_ids: (server.groups || []).map(g => g.id),
    tag_ids: (server.tags || []).map(t => t.id),
    notes: server.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoSecState, setAutoSecState] = useState(server.auto_security_updates)
  const [autoSecLines, setAutoSecLines] = useState<string[]>([])
  const [autoSecRunning, setAutoSecRunning] = useState(false)
  const [eepromState, setEepromState] = useState(server.eeprom_update_available)
  const [eepromLines, setEepromLines] = useState<string[]>([])
  const [eepromRunning, setEepromRunning] = useState(false)
  const eepromWsRef = useRef<WebSocket | null>(null)
  const eepromTermRef = useRef<HTMLDivElement | null>(null)
  const autoSecTermRef = useRef<HTMLDivElement>(null)
  const autoSecWsRef = useRef<WebSocket | null>(null)
  const [aptProxyState, setAptProxyState] = useState(server.apt_proxy)
  const [aptProxyInput, setAptProxyInput] = useState(
    server.apt_proxy && server.apt_proxy !== 'auto-apt-proxy' ? server.apt_proxy : ''
  )
  const [aptProxyMode, setAptProxyMode] = useState<'manual' | 'auto'>(
    server.apt_proxy === 'auto-apt-proxy' ? 'auto' : 'manual'
  )
  const [aptProxyLines, setAptProxyLines] = useState<string[]>([])
  const [aptProxyRunning, setAptProxyRunning] = useState(false)
  const aptProxyTermRef = useRef<HTMLDivElement>(null)
  const aptProxyWsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    tagsApi.list().then(setTagList)
  }, [])

  useEffect(() => {
    setEditForm({
      name: server.name,
      hostname: server.hostname,
      username: server.username,
      ssh_port: String(server.ssh_port),
      is_enabled: server.is_enabled,
      group_ids: (server.groups || []).map(g => g.id),
      tag_ids: (server.tags || []).map(t => t.id),
      notes: server.notes ?? '',
    })
    setAutoSecState(server.auto_security_updates)
    setAptProxyState(server.apt_proxy)
    setAptProxyInput(server.apt_proxy && server.apt_proxy !== 'auto-apt-proxy' ? server.apt_proxy : '')
    setAptProxyMode(server.apt_proxy === 'auto-apt-proxy' ? 'auto' : 'manual')
  }, [server])

  function toggleGroup(id: number) {
    setEditForm(f => ({
      ...f,
      group_ids: f.group_ids.includes(id) ? f.group_ids.filter(x => x !== id) : [...f.group_ids, id],
    }))
  }

  function toggleTag(id: number) {
    setEditForm(f => ({
      ...f,
      tag_ids: f.tag_ids.includes(id) ? f.tag_ids.filter(x => x !== id) : [...f.tag_ids, id],
    }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await serversApi.update(server.id, {
        name: editForm.name,
        hostname: editForm.hostname,
        username: editForm.username,
        ssh_port: parseInt(editForm.ssh_port) || 22,
        group_id: editForm.group_ids[0] ?? null,
        group_ids: editForm.group_ids,
        is_enabled: editForm.is_enabled,
        tag_ids: editForm.tag_ids,
        notes: editForm.notes || undefined,
      })
      onSaved()
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  function handleAutoSecToggle(enable: boolean) {
    setAutoSecLines([])
    setAutoSecRunning(true)
    autoSecWsRef.current?.close()
    const ws = createAutoSecurityUpdatesWebSocket(server.id, { enable }, (msg) => {
      if (msg.type === 'output') {
        setAutoSecLines(l => applyChunk(l, msg.data as string))
      } else if (msg.type === 'status') {
        setAutoSecLines(l => [...l, `\x1b[36m[${msg.data}]\x1b[0m\n`])
      } else if (msg.type === 'error') {
        setAutoSecLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'complete') {
        const d = msg.data as { success: boolean; auto_security_updates: string | null }
        if (d.success && d.auto_security_updates) setAutoSecState(d.auto_security_updates)
        setAutoSecLines(l => [...l, `\x1b[${d.success ? '32' : '31'}m\n[complete] ${d.success ? '✓ Done' : '✗ Failed'}\x1b[0m\n`])
      }
      setTimeout(() => {
        if (autoSecTermRef.current) autoSecTermRef.current.scrollTop = autoSecTermRef.current.scrollHeight
      }, 0)
    }, () => setAutoSecRunning(false))
    autoSecWsRef.current = ws
  }

  function handleAptProxyToggle(enable: boolean) {
    setAptProxyLines([])
    setAptProxyRunning(true)
    aptProxyWsRef.current?.close()
    const ws = createAptProxyWebSocket(server.id, { enable, mode: aptProxyMode, proxy_url: aptProxyInput.trim() }, (msg) => {
      if (msg.type === 'output') {
        setAptProxyLines(l => applyChunk(l, msg.data as string))
      } else if (msg.type === 'status') {
        setAptProxyLines(l => [...l, `\x1b[36m[${msg.data}]\x1b[0m\n`])
      } else if (msg.type === 'error') {
        setAptProxyLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'complete') {
        const d = msg.data as { success: boolean; apt_proxy: string | null }
        if (d.success) setAptProxyState(d.apt_proxy)
        setAptProxyLines(l => [...l, `\x1b[${d.success ? '32' : '31'}m\n[complete] ${d.success ? '✓ Done' : '✗ Failed'}\x1b[0m\n`])
      }
      setTimeout(() => {
        if (aptProxyTermRef.current) aptProxyTermRef.current.scrollTop = aptProxyTermRef.current.scrollHeight
      }, 0)
    }, () => setAptProxyRunning(false))
    aptProxyWsRef.current = ws
  }

  function handleEepromUpdate() {
    setEepromLines([])
    setEepromRunning(true)
    eepromWsRef.current?.close()
    const ws = createEepromUpdateWebSocket(server.id, (msg) => {
      if (msg.type === 'output') {
        setEepromLines(l => applyChunk(l, msg.data as string))
      } else if (msg.type === 'status') {
        setEepromLines(l => [...l, `\x1b[36m[${msg.data}]\x1b[0m\n`])
      } else if (msg.type === 'error') {
        setEepromLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'complete') {
        const d = msg.data as { success: boolean }
        if (d.success) setEepromState('update_staged')
        setEepromLines(l => [...l, `\x1b[${d.success ? '32' : '31'}m\n[complete] ${d.success ? '✓ Update staged — reboot to apply' : '✗ Failed'}\x1b[0m\n`])
      }
      setTimeout(() => {
        if (eepromTermRef.current) eepromTermRef.current.scrollTop = eepromTermRef.current.scrollHeight
      }, 0)
    }, () => setEepromRunning(false))
    eepromWsRef.current = ws
  }

  return (
    <div className="card p-4 space-y-3">
      <h3 className="text-xs text-text-muted uppercase tracking-wide">Edit Server</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className="label">Display Name</label>
          <input className="input w-full text-sm" value={editForm.name}
            onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
        </div>
        <div>
          <label className="label">Hostname</label>
          <input className="input w-full text-sm" value={editForm.hostname}
            onChange={e => setEditForm(f => ({ ...f, hostname: e.target.value }))} />
        </div>
        <div>
          <label className="label">SSH User</label>
          <input className="input w-full text-sm" value={editForm.username}
            onChange={e => setEditForm(f => ({ ...f, username: e.target.value }))} />
        </div>
        <div>
          <label className="label">Port</label>
          <input className="input w-full text-sm" type="number" value={editForm.ssh_port}
            onChange={e => setEditForm(f => ({ ...f, ssh_port: e.target.value }))} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">Groups</label>
          <div className="flex flex-wrap gap-1.5">
            {groupList.map(g => {
              const sel = editForm.group_ids.includes(g.id)
              const c = g.color || '#3b82f6'
              return (
                <button key={g.id} type="button" onClick={() => toggleGroup(g.id)}
                  className="px-2 py-0.5 rounded text-xs border transition-all"
                  style={{
                    background: sel ? c + '33' : 'transparent',
                    color: sel ? c : undefined,
                    borderColor: sel ? c + '88' : c + '44',
                    opacity: sel ? 1 : 0.55,
                  }}>
                  {g.name}
                </button>
              )
            })}
            {groupList.length === 0 && <span className="text-xs text-text-muted">No groups defined</span>}
          </div>
        </div>

        <div>
          <label className="label">Tags</label>
          <div className="flex flex-wrap gap-1.5">
            {tagList.map(t => {
              const sel = editForm.tag_ids.includes(t.id)
              const c = t.color || '#6366f1'
              return (
                <button key={t.id} type="button" onClick={() => toggleTag(t.id)}
                  className="px-2 py-0.5 rounded text-xs border transition-all"
                  style={{
                    background: sel ? c + '33' : 'transparent',
                    color: sel ? c : undefined,
                    borderColor: sel ? c + '88' : c + '44',
                    opacity: sel ? 1 : 0.55,
                  }}>
                  # {t.name}
                </button>
              )
            })}
            {tagList.length === 0 && <span className="text-xs text-text-muted">No tags defined</span>}
          </div>
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer w-fit">
          <input type="checkbox" checked={editForm.is_enabled}
            onChange={e => setEditForm(f => ({ ...f, is_enabled: e.target.checked }))}
            className="w-4 h-4 accent-green" />
          Enabled
        </label>
      </div>

      <div>
        <label className="label">Notes</label>
        <textarea
          className="input w-full text-sm resize-y"
          rows={2}
          placeholder="Optional notes about this server…"
          value={editForm.notes}
          onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
        />
      </div>

      {/* Auto security updates */}
      {autoSecState !== null && (
        <div className="border border-border rounded p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-text-muted uppercase tracking-wide">Auto Security Updates</span>
              <div className="flex items-center gap-2 mt-0.5">
                {autoSecState === 'enabled' && <span className="text-xs text-green font-mono">🛡 enabled</span>}
                {autoSecState === 'disabled' && <span className="text-xs text-text-muted font-mono">disabled</span>}
                {autoSecState === 'not_installed' && <span className="text-xs text-amber font-mono">unattended-upgrades not installed</span>}
              </div>
            </div>
            <div className="flex gap-2">
              {autoSecState !== 'enabled' && (
                <button onClick={() => handleAutoSecToggle(true)} disabled={autoSecRunning} className="btn-primary text-xs py-0.5">
                  {autoSecRunning ? '…' : 'Enable'}
                </button>
              )}
              {autoSecState === 'enabled' && (
                <button onClick={() => handleAutoSecToggle(false)} disabled={autoSecRunning} className="btn-secondary text-xs py-0.5">
                  {autoSecRunning ? '…' : 'Disable'}
                </button>
              )}
            </div>
          </div>
          {autoSecLines.length > 0 && (
            <div
              ref={autoSecTermRef}
              className="bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary overflow-y-auto"
              style={{ maxHeight: '200px' }}
            >
              {autoSecLines.map((line, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
              ))}
              {autoSecRunning && <span className="text-cyan animate-pulse">▋</span>}
            </div>
          )}
        </div>
      )}

      {/* apt Proxy configuration */}
      <div className="border border-border rounded p-3 space-y-2">
        <div className="space-y-2">
          <span className="text-xs text-text-muted uppercase tracking-wide">apt HTTP Proxy</span>
          <div className="flex items-center gap-2">
            {aptProxyState
              ? <span className="text-xs text-cyan font-mono">⚡ {aptProxyState === 'auto-apt-proxy' ? 'auto-apt-proxy (DNS)' : aptProxyState}</span>
              : <span className="text-xs text-text-muted font-mono">not configured</span>}
          </div>
          {/* Mode selector */}
          <div className="flex gap-3 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="apt-proxy-mode" value="manual" checked={aptProxyMode === 'manual'} onChange={() => setAptProxyMode('manual')} disabled={aptProxyRunning} className="accent-cyan" />
              <span className="text-text-primary">Manual URL</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="apt-proxy-mode" value="auto" checked={aptProxyMode === 'auto'} onChange={() => setAptProxyMode('auto')} disabled={aptProxyRunning} className="accent-cyan" />
              <span className="text-text-primary">auto-apt-proxy <span className="text-text-muted">(DNS / mDNS discovery)</span></span>
            </label>
          </div>
          {aptProxyMode === 'manual' && (
            <div className="flex gap-2 items-center flex-wrap">
              <input
                className="input text-xs py-1 w-64 font-mono"
                placeholder="http://192.168.1.10:3142/"
                value={aptProxyInput}
                onChange={e => setAptProxyInput(e.target.value)}
                disabled={aptProxyRunning}
              />
              <button
                onClick={() => handleAptProxyToggle(true)}
                disabled={aptProxyRunning || !aptProxyInput.trim()}
                className="btn-primary text-xs py-0.5"
              >
                {aptProxyRunning ? '…' : aptProxyState && aptProxyState !== 'auto-apt-proxy' ? 'Update' : 'Enable'}
              </button>
            </div>
          )}
          {aptProxyMode === 'auto' && (
            <div className="flex gap-2 items-center">
              <button
                onClick={() => handleAptProxyToggle(true)}
                disabled={aptProxyRunning || aptProxyState === 'auto-apt-proxy'}
                className="btn-primary text-xs py-0.5"
              >
                {aptProxyRunning ? '…' : 'Install auto-apt-proxy'}
              </button>
              <span className="text-xs text-text-muted">Installs package, discovers proxy via DNS SRV record or mDNS</span>
            </div>
          )}
          {aptProxyState && (
            <button
              onClick={() => handleAptProxyToggle(false)}
              disabled={aptProxyRunning}
              className="btn-secondary text-xs py-0.5"
            >
              {aptProxyRunning ? '…' : 'Disable / Remove'}
            </button>
          )}
        </div>
        {aptProxyLines.length > 0 && (
          <div
            ref={aptProxyTermRef}
            className="bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary overflow-y-auto"
            style={{ maxHeight: '200px' }}
          >
            {aptProxyLines.map((line, i) => (
              <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
            ))}
            {aptProxyRunning && <span className="text-cyan animate-pulse">▋</span>}
          </div>
        )}
      </div>

      {/* EEPROM firmware update (Raspberry Pi 4/400/CM4/5 only) */}
      {eepromState !== null && (
        <div className="border border-border rounded p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-text-muted uppercase tracking-wide">EEPROM Firmware</span>
              <div className="flex items-center gap-2 mt-0.5">
                {eepromState === 'up_to_date' && <span className="text-xs text-green font-mono">✓ up to date</span>}
                {eepromState === 'update_available' && <span className="text-xs text-amber font-mono">⬆ update available</span>}
                {eepromState === 'update_staged' && <span className="text-xs text-blue font-mono">⬆ staged — reboot to apply</span>}
                {eepromState === 'frozen' && <span className="text-xs text-text-muted font-mono">frozen</span>}
                {eepromState === 'error' && <span className="text-xs text-red font-mono">error</span>}
                {server.eeprom_current_version && (
                  <span className="text-xs text-text-muted font-mono">
                    current: {new Date(parseInt(server.eeprom_current_version) * 1000).toLocaleDateString()}
                    {server.eeprom_latest_version && server.eeprom_latest_version !== server.eeprom_current_version && (
                      <> → latest: {new Date(parseInt(server.eeprom_latest_version) * 1000).toLocaleDateString()}</>
                    )}
                  </span>
                )}
              </div>
            </div>
            {eepromState === 'update_available' && (
              <button onClick={handleEepromUpdate} disabled={eepromRunning} className="btn-primary text-xs py-0.5">
                {eepromRunning ? '…' : 'Apply Update'}
              </button>
            )}
          </div>
          {eepromState === 'update_staged' && (
            <p className="text-xs text-blue font-mono">Reboot required to complete firmware update.</p>
          )}
          {eepromLines.length > 0 && (
            <div
              ref={eepromTermRef}
              className="bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary overflow-y-auto"
              style={{ maxHeight: '200px' }}
            >
              {eepromLines.map((line, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
              ))}
              {eepromRunning && <span className="text-cyan animate-pulse">▋</span>}
            </div>
          )}
        </div>
      )}

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
  const [showDebModal, setShowDebModal] = useState(false)

  const loadPackages = useCallback(() => {
    serversApi.packages(serverId).then(data => {
      setPackages(data.packages)
      setHeld(data.held)
      setAutoremove(data.autoremove ?? [])
      setSelected(new Set())
      setSelectedRemove(new Set())
    })
  }, [serverId])

  // Re-fetch whenever the check timestamp changes (e.g. after "Check Now")
  const checkedAt = server.latest_check?.checked_at
  useEffect(() => { loadPackages() }, [loadPackages, checkedAt])

  const upgradable = packages.filter(p => !p.is_new)
  const newPkgs = packages.filter(p => p.is_new)
  const hasNewKernels = newPkgs.some(p => p.is_kernel)
  const keptBackCount = upgradable.filter(p => p.needs_dist_upgrade).length

  const sorted = [...upgradable]
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
      {/* Install buttons — always visible */}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => setShowDebModal(true)}
          className="btn-secondary text-xs"
        >
          + Install .deb
        </button>
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
          {/* Dist-upgrade required banner */}
          {(keptBackCount > 0 || newPkgs.length > 0) && (
            <div className="rounded border border-amber/30 bg-amber/5 px-3 py-2 text-xs space-y-1">
              <p className="font-medium text-amber">
                {keptBackCount > 0
                  ? `⚠ ${keptBackCount} package${keptBackCount > 1 ? 's' : ''} require dist-upgrade to install`
                  : `⚠ ${newPkgs.length} new package${newPkgs.length > 1 ? 's' : ''} will be installed as dependencies`}
              </p>
              <p className="text-text-muted">
                {keptBackCount > 0
                  ? <>Packages marked <span className="font-mono text-amber">kept back</span> have new dependencies and cannot be installed with a plain upgrade. Use the <span className="font-mono">Upgrade</span> tab and select the <span className="font-mono">dist-upgrade</span> action.</>
                  : <>These packages are pulled in as new dependencies when upgrading (e.g. a new kernel version). Use the <span className="font-mono">Upgrade</span> tab with the <span className="font-mono">dist-upgrade</span> action to install them. A reboot will be required; old packages can be removed via autoremove afterward.</>
                }
              </p>
            </div>
          )}

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
              onClick={() => { setSelected(new Set(upgradable.map(p => p.name))); setUpgradeModal(true) }}
              disabled={upgradable.length === 0}
              className="btn-amber text-xs"
            >
              Upgrade All ({upgradable.length})
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
                  <th className="text-left px-3 py-2">Phased</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => {
                  const reboot = likelyRequiresReboot(p.name)
                  const isPve = server.is_proxmox && /^(pve-|proxmox-|pve-kernel-|pvetest-)/.test(p.name)
                  return (
                  <tr
                    key={p.name}
                    onClick={() => toggleOne(p.name)}
                    className={`border-b border-border/30 cursor-pointer transition-colors
                      ${selected.has(p.name) ? 'bg-green/5 border-green/20' : p.is_security ? 'bg-red/5' : p.needs_dist_upgrade ? 'bg-amber/5' : isPve ? 'bg-orange-500/5' : ''}
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
                      {isPve && <span className="text-orange-400 mr-1" title="Proxmox VE package — use pveupgrade">🔶</span>}
                      {p.name}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-text-muted">{p.current_version}</td>
                    <td className="px-3 py-1.5 font-mono text-text-primary">→ {p.available_version}</td>
                    <td className="px-3 py-1.5 font-mono text-text-muted text-xs">{p.repository}</td>
                    <td className="px-3 py-1.5 text-center">
                      {p.is_phased && <span className="badge bg-blue/10 text-blue border border-blue/30 text-xs">phased</span>}
                      {p.needs_dist_upgrade && <span className="badge bg-amber/10 text-amber border border-amber/30 text-xs" title="Requires dist-upgrade — has new dependencies">kept back</span>}
                    </td>
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
                                {p.needs_dist_upgrade && <p className="text-amber">⚠ Kept back — requires dist-upgrade</p>}
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

      {newPkgs.length > 0 && (
        <div>
          <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">
            New Packages ({newPkgs.length})
            <span className="ml-2 normal-case font-normal text-text-muted/70">— will be installed as dependencies when upgrading</span>
          </h3>
          <div className="card overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-text-muted uppercase text-xs">
                  <th className="text-left px-3 py-2">Package</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {newPkgs.map(p => (
                  <tr key={p.name} className={`border-b border-border/30 ${p.is_kernel ? 'bg-cyan/5' : ''}`}>
                    <td className="px-3 py-1.5 font-mono">
                      {p.is_kernel && <span className="text-cyan mr-1" title="New kernel package">🐧</span>}
                      {p.name}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {p.description && (
                        <span className="relative group/info inline-block">
                          <span className="text-text-muted/50 hover:text-cyan cursor-default select-none text-xs font-mono">ⓘ</span>
                          <div className="absolute right-0 bottom-full mb-1 z-50 hidden group-hover/info:block w-72 pointer-events-none">
                            <div className="bg-surface border border-border rounded shadow-lg p-3 text-xs space-y-1.5">
                              <p className="font-mono font-medium text-text-primary">{p.name}</p>
                              <p className="text-text-muted leading-snug">{p.description}</p>
                              <p className="text-cyan text-xs">New install (dependency)</p>
                            </div>
                          </div>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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

      {showDebModal && (
        <DebInstallModal
          serverId={serverId}
          onClose={() => { setShowDebModal(false); loadPackages(); onRefresh() }}
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
        if (msg.type === 'output') setLines(l => applyChunk(l, msg.data as string))
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
        if (msg.type === 'output') setLines(l => applyChunk(l, msg.data as string))
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
const CONTAINER_RUNTIME_PKGS = /^(docker-ce|docker-ce-cli|docker-ce-rootless-extras|docker\.io|containerd|containerd\.io|docker-buildx-plugin|docker-compose-plugin|moby-engine|podman|podman-compose|buildah|runc|crun|lxd|lxc|lxc-utils|lxcfs)$/

function UpgradePanel({ serverId, server, onRefresh }: { serverId: number; server: Server; onRefresh: () => void }) {
  const [action, setAction] = useState('upgrade')
  const [allowPhased, setAllowPhased] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [dryRunLines, setDryRunLines] = useState<string[]>([])
  const [dryRunning, setDryRunning] = useState(false)
  const [showDryRun, setShowDryRun] = useState(false)
  const [runtimePkgs, setRuntimePkgs] = useState<string[]>([])
  const [pveUpgrading, setPveUpgrading] = useState(false)
  const dryWsRef = useRef<WebSocket | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pveWsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const dryTermRef = useRef<HTMLDivElement>(null)
  const { addJob, updateJob } = useJobStore()

  useEffect(() => () => { wsRef.current?.close(); dryWsRef.current?.close() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Detect container-runtime packages in the upgrade list
  useEffect(() => {
    if (!server.is_docker_host) return
    serversApi.packages(serverId).then(data => {
      const found = (data.packages as PackageInfo[])
        .map(p => p.name)
        .filter(n => CONTAINER_RUNTIME_PKGS.test(n))
      setRuntimePkgs(found)
    }).catch(() => {})
  }, [serverId, server.is_docker_host]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
  }, [lines])
  useEffect(() => {
    if (dryTermRef.current) dryTermRef.current.scrollTop = dryTermRef.current.scrollHeight
  }, [dryRunLines])

  function runDryRun() {
    setDryRunLines([])
    setDryRunning(true)
    setShowDryRun(true)
    dryWsRef.current?.close()
    const ws = createDryRunWebSocket(serverId, { action, allow_phased: allowPhased }, (msg) => {
      if (msg.type === 'output') setDryRunLines(l => applyChunk(l, msg.data as string))
      else if (msg.type === 'status') setDryRunLines(l => [...l, `\x1b[36m[${msg.data}]\x1b[0m\n`])
      else if (msg.type === 'error') setDryRunLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
      else if (msg.type === 'complete') setDryRunLines(l => [...l, `\x1b[32m\n[dry-run complete]\x1b[0m\n`])
    }, () => setDryRunning(false))
    dryWsRef.current = ws
  }

  function runAptUpdate() {
    setLines([])
    setDone(false)
    setRunning(true)
    const ws = createAptUpdateWebSocket(serverId, (msg) => {
      if (msg.type === 'output') {
        setLines(l => applyChunk(l, msg.data as string))
      } else if (msg.type === 'status') {
        setLines(l => [...l, `\x1b[36m[status] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'error') {
        setLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'complete') {
        setLines(l => [...l, `\x1b[32m\n[complete] ✓ apt-get update finished\x1b[0m\n`])
      }
    }, () => {
      setRunning(false)
      setDone(true)
      onRefresh()
    })
    wsRef.current = ws
  }

  function startPveUpgrade() {
    setLines([])
    setDone(false)
    setRunning(true)
    setPveUpgrading(true)
    const jobId = `upgrade-${serverId}`
    addJob({ id: jobId, type: 'upgrade', label: `pveupgrade ${server.name}`, status: 'running', link: `/servers/${serverId}`, startedAt: Date.now() })
    const ws = createPveUpgradeWebSocket(serverId, (msg) => {
      if (msg.type === 'output') setLines(l => applyChunk(l, msg.data as string))
      else if (msg.type === 'status') setLines(l => [...l, `\x1b[36m[${msg.data}]\x1b[0m\n`])
      else if (msg.type === 'error') { setLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`]); updateJob(jobId, { status: 'error', completedAt: Date.now() }) }
      else if (msg.type === 'complete') {
        const d = msg.data as { success: boolean }
        setLines(l => [...l, `\x1b[${d.success ? '32' : '31'}m\n[complete] ${d.success ? '✓ pveupgrade successful' : '✗ pveupgrade failed'}\x1b[0m\n`])
        updateJob(jobId, { status: d.success ? 'complete' : 'error', completedAt: Date.now() })
      }
    }, () => { setRunning(false); setPveUpgrading(false); setDone(true); onRefresh(); window.dispatchEvent(new CustomEvent('apt:refresh')) })
    pveWsRef.current = ws
  }

  function startUpgrade() {
    setLines([])
    setDone(false)
    setRunning(true)
    const jobId = `upgrade-${serverId}`
    addJob({ id: jobId, type: 'upgrade', label: `Upgrading ${server.name}`, status: 'running', link: `/servers/${serverId}`, startedAt: Date.now() })

    const ws = createUpgradeWebSocket(serverId, { action, allow_phased: allowPhased }, (msg) => {
      if (msg.type === 'output') {
        setLines(l => applyChunk(l, msg.data as string))
      } else if (msg.type === 'status') {
        setLines(l => [...l, `\x1b[36m[status] ${msg.data}\x1b[0m\n`])
      } else if (msg.type === 'error') {
        setLines(l => [...l, `\x1b[31m[error] ${msg.data}\x1b[0m\n`])
        updateJob(jobId, { status: 'error', completedAt: Date.now() })
      } else if (msg.type === 'complete') {
        const data = msg.data as { success: boolean; packages_upgraded: number }
        setLines(l => [...l, `\x1b[${data.success ? '32' : '31'}m\n[complete] ${data.success ? '✓ Upgrade successful' : '✗ Upgrade failed'} — ${data.packages_upgraded} packages\x1b[0m\n`])
        updateJob(jobId, { status: data.success ? 'complete' : 'error', completedAt: Date.now() })
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
      {server.is_docker_host && runtimePkgs.length > 0 && (
        <div className="rounded border border-red/50 bg-red/10 px-4 py-3 text-sm space-y-2">
          <p className="font-semibold text-red">🐳 Upgrade blocked — Docker host</p>
          <p className="text-text-muted">
            <span className="font-mono text-red">{runtimePkgs.join(', ')}</span>{' '}
            are in the upgrade list. Upgrading these will restart Docker and kill this container mid-upgrade. <strong className="text-text-primary">Run Upgrade is disabled.</strong>
          </p>
          <p className="text-text-muted">
            Use <strong className="text-text-primary">Selective Upgrade</strong> on the Packages tab to upgrade everything else, then handle these packages directly on the host:
          </p>
          <pre className="bg-bg rounded px-3 py-2 text-xs font-mono text-text-primary overflow-x-auto select-all">{`ssh ${server.username}@${server.hostname}${server.ssh_port !== 22 ? ` -p ${server.ssh_port}` : ''}\nsudo apt-get install --only-upgrade ${runtimePkgs.join(' ')}`}</pre>
        </div>
      )}
      {server.is_docker_host && runtimePkgs.length === 0 && (server.latest_check?.packages_available ?? 0) > 0 && (
        <div className="rounded border border-purple/30 bg-purple/5 px-4 py-2 text-xs text-text-muted">
          🐳 This is the Docker host. No container-runtime packages in the current upgrade list.
        </div>
      )}
      {server.is_proxmox && (
        <div className="rounded border border-orange-500/40 bg-orange-500/5 px-4 py-3 text-sm space-y-2">
          <p className="font-semibold text-orange-400">🔶 Proxmox VE node</p>
          <p className="text-text-muted text-xs">
            Proxmox VE uses <code className="font-mono bg-bg px-1 rounded">pveupgrade</code> which runs{' '}
            <code className="font-mono bg-bg px-1 rounded">apt dist-upgrade</code> with PVE-specific pre/post hooks.
            Using plain <code className="font-mono bg-bg px-1 rounded">apt-get upgrade</code> may skip PVE meta-packages or miss
            post-install steps. Use <strong className="text-orange-300">Run pveupgrade</strong> for safer upgrades.
          </p>
          {!running && (
            <button
              onClick={startPveUpgrade}
              disabled={!hasUpdates}
              className="btn text-xs px-3 py-1.5 border border-orange-500/50 text-orange-300 hover:bg-orange-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Run pveupgrade
            </button>
          )}
          {pveUpgrading && running && (
            <span className="text-xs text-orange-300 font-mono flex items-center gap-1">
              <span className="w-3 h-3 border-2 border-orange-300 border-t-transparent rounded-full animate-spin" />
              pveupgrade running…
            </span>
          )}
        </div>
      )}
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
              onClick={runAptUpdate}
              className="btn-secondary"
              title="Refresh package lists from remote repositories"
            >
              apt-get update
            </button>
            <button
              onClick={runDryRun}
              disabled={dryRunning || !hasUpdates}
              className="btn-secondary"
              title="Preview what would be upgraded without making any changes"
            >
              {dryRunning ? 'Previewing…' : 'Preview'}
            </button>
            <button
              onClick={startUpgrade}
              disabled={!hasUpdates || (server.is_docker_host && runtimePkgs.length > 0)}
              className="btn-amber"
              title={!hasUpdates ? 'No updates available' : (server.is_docker_host && runtimePkgs.length > 0) ? 'Blocked: container-runtime packages would be upgraded — see warning above' : ''}
            >
              Run Upgrade
            </button>
          </div>
        </div>
      )}

      {/* Dry-run output */}
      {showDryRun && dryRunLines.length > 0 && (
        <div className="card p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted uppercase tracking-wide">Dry-run preview</span>
            <button onClick={() => setShowDryRun(false)} className="text-text-muted hover:text-text-primary text-xs">✕ close</button>
          </div>
          <div
            ref={dryTermRef}
            className="bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary overflow-y-auto"
            style={{ maxHeight: '300px' }}
          >
            {dryRunLines.map((line, i) => (
              <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
            ))}
            {dryRunning && <span className="text-cyan animate-pulse">▋</span>}
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


// ---------------------------------------------------------------------------
// dpkg Log tab
// ---------------------------------------------------------------------------
const ACTION_COLORS: Record<string, string> = {
  install: 'text-green bg-green/10 border-green/30',
  upgrade: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/30',
  remove:  'text-amber bg-amber/10 border-amber/30',
  purge:   'text-red-400 bg-red-400/10 border-red-400/30',
}

function DpkgLogTab({ serverId }: { serverId: number }) {
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<DpkgLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const LIMIT = 200

  // Filters
  const [pkgFilter, setPkgFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [daysFilter, setDaysFilter] = useState('')

  async function fetchLog(newOffset = 0) {
    setLoading(true)
    setError(null)
    try {
      const params: Parameters<typeof serversApi.dpkgLog>[1] = { limit: LIMIT, offset: newOffset }
      if (pkgFilter.trim()) params.package = pkgFilter.trim()
      if (actionFilter) params.action = actionFilter
      if (daysFilter) params.days = parseInt(daysFilter)
      const result = await serversApi.dpkgLog(serverId, params)
      setItems(result.items)
      setTotal(result.total)
      setOffset(newOffset)
      setLoaded(true)
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function formatTs(iso: string) {
    // iso is YYYY-MM-DDTHH:MM:SS
    return iso.replace('T', ' ')
  }

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))
  const currentPage = Math.floor(offset / LIMIT) + 1

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Filter by package…"
          value={pkgFilter}
          onChange={e => setPkgFilter(e.target.value)}
          className="input text-xs py-1 w-48"
        />
        <select value={actionFilter} onChange={e => setActionFilter(e.target.value)} className="input text-xs py-1 w-auto">
          <option value="">All actions</option>
          <option value="install">Install</option>
          <option value="upgrade">Upgrade</option>
          <option value="remove">Remove</option>
          <option value="purge">Purge</option>
        </select>
        <select value={daysFilter} onChange={e => setDaysFilter(e.target.value)} className="input text-xs py-1 w-auto">
          <option value="">All time</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last year</option>
        </select>
        <button
          onClick={() => fetchLog(0)}
          disabled={loading}
          className="btn-primary text-xs py-1"
        >
          {loading ? 'Loading…' : loaded ? 'Reload' : 'Load History'}
        </button>
        {loaded && <span className="text-xs text-text-muted">{total.toLocaleString()} entries</span>}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/30 rounded px-3 py-2">{error}</div>
      )}

      {!loaded && !loading && (
        <p className="text-text-muted text-sm py-8 text-center">
          Click <strong>Load History</strong> to fetch dpkg.log from the server.
        </p>
      )}

      {loaded && items.length === 0 && (
        <p className="text-text-muted text-sm py-8 text-center">No entries match the current filters.</p>
      )}

      {loaded && items.length > 0 && (
        <>
          <div className="card overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="text-left px-3 py-2 font-medium">Date/Time</th>
                  <th className="text-left px-3 py-2 font-medium">Action</th>
                  <th className="text-left px-3 py-2 font-medium">Package</th>
                  <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Arch</th>
                  <th className="text-left px-3 py-2 font-medium">From</th>
                  <th className="text-left px-3 py-2 font-medium">To</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-white/5">
                    <td className="px-3 py-1.5 font-mono text-text-muted whitespace-nowrap">{formatTs(entry.timestamp)}</td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-xs font-medium ${ACTION_COLORS[entry.action] ?? ''}`}>
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-text-primary">{entry.package}</td>
                    <td className="px-3 py-1.5 text-text-muted hidden sm:table-cell">{entry.arch}</td>
                    <td className="px-3 py-1.5 font-mono text-text-muted">{entry.old_version || '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-text-muted">{entry.new_version || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex gap-2 items-center justify-center">
              <button disabled={currentPage === 1} onClick={() => fetchLog(offset - LIMIT)} className="btn-secondary text-xs">Prev</button>
              <span className="text-text-muted text-xs">{currentPage} / {totalPages}</span>
              <button disabled={currentPage >= totalPages} onClick={() => fetchLog(offset + LIMIT)} className="btn-secondary text-xs">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Apt Repos Tab
// ---------------------------------------------------------------------------

function AptReposTab({ serverId }: { serverId: number }) {
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<AptRepoFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Tracks unsaved edits per file path — cleared on save
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveOk, setSaveOk] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // New file form
  const [showNewForm, setShowNewForm] = useState(false)
  const [newFilename, setNewFilename] = useState('')
  const [newFileError, setNewFileError] = useState<string | null>(null)

  // apt-get update test terminal
  const [testLines, setTestLines] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<boolean | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
  }, [testLines])

  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

  async function loadRepos() {
    setLoading(true)
    setError(null)
    try {
      const result = await serversApi.aptRepos(serverId)
      setFiles(result.files)
      setSelectedPath(prev => {
        // Keep current selection if still present, otherwise pick first
        if (prev && result.files.some(f => f.path === prev)) return prev
        return result.files[0]?.path ?? null
      })
      setLoaded(true)
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const currentFile = files.find(f => f.path === selectedPath) ?? null
  const currentContent = selectedPath != null
    ? (pendingEdits[selectedPath] ?? currentFile?.content ?? '')
    : ''

  function isDirty(path: string): boolean {
    if (pendingEdits[path] === undefined) return false
    const file = files.find(f => f.path === path)
    return pendingEdits[path] !== file?.content
  }

  async function saveFile() {
    if (!selectedPath) return
    setSaving(true)
    setSaveError(null)
    setSaveOk(false)
    try {
      await serversApi.saveAptRepo(serverId, selectedPath, currentContent)
      setFiles(prev => prev.map(f =>
        f.path === selectedPath ? { ...f, content: currentContent } : f
      ))
      setPendingEdits(prev => { const next = { ...prev }; delete next[selectedPath!]; return next })
      setSaveOk(true)
      setTimeout(() => setSaveOk(false), 3000)
    } catch (e: unknown) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function deleteFile() {
    if (!selectedPath || !currentFile?.deletable) return
    if (!window.confirm(`Delete ${selectedPath}?\n\nThis cannot be undone.`)) return
    setDeleting(true)
    setSaveError(null)
    try {
      await serversApi.deleteAptRepo(serverId, selectedPath)
      const remaining = files.filter(f => f.path !== selectedPath)
      setFiles(remaining)
      setPendingEdits(prev => { const next = { ...prev }; delete next[selectedPath!]; return next })
      setSelectedPath(remaining[0]?.path ?? null)
    } catch (e: unknown) {
      setSaveError(String(e))
    } finally {
      setDeleting(false)
    }
  }

  function addNewFile() {
    const filename = newFilename.trim()
    if (!filename) return
    if (!/^[a-zA-Z0-9._\-]+\.(list|sources)$/.test(filename)) {
      setNewFileError('Filename must end in .list or .sources and contain only letters, numbers, dots, hyphens, underscores.')
      return
    }
    const path = `/etc/apt/sources.list.d/${filename}`
    if (files.some(f => f.path === path)) {
      setNewFileError('A file with that name already exists.')
      return
    }
    const newFile: AptRepoFile = {
      path,
      content: '',
      format: filename.endsWith('.sources') ? 'deb822' : 'one-line',
      deletable: true,
    }
    setFiles(prev => [...prev, newFile])
    setSelectedPath(path)
    setShowNewForm(false)
    setNewFilename('')
    setNewFileError(null)
    setSaveError(null)
    setSaveOk(false)
  }

  function runTest() {
    if (testing) return
    setTestLines([])
    setTestResult(null)
    setTesting(true)
    wsRef.current?.close()
    wsRef.current = createAptReposTestWebSocket(serverId, (msg) => {
      if (msg.type === 'output') {
        setTestLines(prev => applyChunk(prev, msg.data as string))
      } else if (msg.type === 'complete') {
        const ok = (msg.data as Record<string, unknown>).success as boolean
        setTestResult(ok)
        setTesting(false)
      } else if (msg.type === 'error') {
        setTestLines(prev => [...prev, `ERROR: ${msg.data as string}`])
        setTestResult(false)
        setTesting(false)
      }
    })
  }

  return (
    <div className="space-y-4">
      {/* Warning */}
      <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2 text-xs text-amber-400">
        <span className="shrink-0 mt-0.5">⚠</span>
        <span>
          Changes to apt sources take effect the next time{' '}
          <code className="bg-black/30 px-1 rounded">apt-get update</code> runs.
          Invalid sources will break package management on this server.
        </span>
      </div>

      {/* Load button */}
      {!loaded && (
        <div className="flex items-center gap-3">
          <button onClick={loadRepos} disabled={loading} className="btn-primary text-xs py-1">
            {loading ? 'Loading…' : 'Load Repos'}
          </button>
          {!loading && (
            <p className="text-text-muted text-sm">
              Reads <code className="text-xs bg-black/30 px-1 rounded">/etc/apt/sources.list</code> and{' '}
              <code className="text-xs bg-black/30 px-1 rounded">sources.list.d/</code> from the server.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/30 rounded px-3 py-2">{error}</div>
      )}

      {loaded && files.length === 0 && (
        <p className="text-text-muted text-sm py-4 text-center">No apt source files found on this server.</p>
      )}

      {loaded && (
        <>
          {/* File tabs */}
          <div className="flex flex-wrap items-center gap-0 border-b border-border">
            {files.map(f => {
              const name = f.path.split('/').pop() ?? f.path
              const dirty = isDirty(f.path)
              return (
                <button
                  key={f.path}
                  onClick={() => { setSelectedPath(f.path); setSaveError(null); setSaveOk(false) }}
                  title={f.path}
                  className={`px-3 py-1.5 text-xs -mb-px border-b-2 transition-colors font-mono whitespace-nowrap ${
                    selectedPath === f.path
                      ? 'border-green text-text-primary'
                      : 'border-transparent text-text-muted hover:text-text-primary'
                  }`}
                >
                  {name}
                  {dirty && <span className="text-amber-400 ml-1">•</span>}
                </button>
              )
            })}

            {/* New file inline form */}
            {!showNewForm ? (
              <button
                onClick={() => { setShowNewForm(true); setNewFilename(''); setNewFileError(null) }}
                className="px-3 py-1.5 text-xs -mb-px border-b-2 border-transparent text-text-muted hover:text-green transition-colors"
              >
                + New File
              </button>
            ) : (
              <div className="flex items-center gap-1 px-2 py-1 -mb-px">
                <input
                  type="text"
                  autoFocus
                  placeholder="myrepo.list"
                  value={newFilename}
                  onChange={e => { setNewFilename(e.target.value); setNewFileError(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') addNewFile(); if (e.key === 'Escape') setShowNewForm(false) }}
                  className="input text-xs py-0.5 w-40 font-mono"
                />
                <button onClick={addNewFile} className="text-xs text-green hover:text-green/80 px-1">✓</button>
                <button onClick={() => setShowNewForm(false)} className="text-xs text-text-muted hover:text-text-primary px-1">✕</button>
              </div>
            )}

            {/* Reload */}
            <button
              onClick={loadRepos}
              disabled={loading}
              className="ml-auto px-2 py-1.5 text-xs -mb-px text-text-muted hover:text-text-primary transition-colors"
              title="Reload all files from server"
            >
              {loading ? '↻…' : '↻ Reload'}
            </button>
          </div>

          {newFileError && (
            <div className="text-xs text-red-400">{newFileError}</div>
          )}

          {/* Editor */}
          {selectedPath && currentFile && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-text-muted">{selectedPath}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded border ${
                  currentFile.format === 'deb822'
                    ? 'border-blue-500/40 text-blue-400 bg-blue-500/10'
                    : 'border-border text-text-muted bg-black/20'
                }`}>
                  {currentFile.format === 'deb822' ? 'DEB822' : 'one-line'}
                </span>
              </div>
              <textarea
                value={currentContent}
                onChange={e => {
                  setSaveError(null)
                  setPendingEdits(prev => ({ ...prev, [selectedPath]: e.target.value }))
                }}
                rows={Math.max(8, (currentContent.match(/\n/g)?.length ?? 0) + 3)}
                spellCheck={false}
                className="w-full bg-black/40 border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:border-green resize-y"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={saveFile}
                  disabled={saving || !isDirty(selectedPath)}
                  className="btn-primary text-xs py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {currentFile.deletable && (
                  <button
                    onClick={deleteFile}
                    disabled={deleting}
                    className="px-3 py-1 text-xs bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 rounded disabled:opacity-40"
                  >
                    {deleting ? 'Deleting…' : 'Delete File'}
                  </button>
                )}
                {saveOk && <span className="text-xs text-green">✓ Saved</span>}
                {saveError && <span className="text-xs text-red-400">{saveError}</span>}
              </div>
            </div>
          )}

          {/* Test section */}
          <div className="border-t border-border pt-4 space-y-2">
            <div className="flex items-center gap-3">
              <button
                onClick={runTest}
                disabled={testing}
                className="btn-secondary text-xs py-1"
              >
                {testing ? (
                  <>
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse mr-1.5" />
                    Running apt-get update…
                  </>
                ) : 'Test with apt-get update'}
              </button>
              {testResult !== null && !testing && (
                <span className={`text-xs font-medium ${testResult ? 'text-green' : 'text-red-400'}`}>
                  {testResult ? '✓ Update succeeded' : '✗ Update failed — check sources above'}
                </span>
              )}
            </div>
            {testLines.length > 0 && (
              <div
                ref={termRef}
                className="bg-black rounded p-3 h-48 overflow-y-auto font-mono text-xs leading-relaxed"
                dangerouslySetInnerHTML={{ __html: testLines.map(l => ansiConvert.toHtml(l)).join('') }}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
