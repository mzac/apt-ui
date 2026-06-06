import { useState, useEffect } from 'react'
import { servers as serversApi } from '@/api/client'
import type { Server } from '@/types'
import { toast } from '@/hooks/useToast'
import { useAuthStore } from '@/hooks/useAuth'

// Safe fleet command runner (issue #62): run an allowlisted command across selected
// servers and group identical outputs ("47 said X, 3 said Y").
const ALLOWLISTED = [
  'uptime', 'uname -a', 'hostnamectl', 'df -h', 'free -h', 'who', 'last -n 5',
  'cat /etc/os-release', 'systemctl --failed', 'dpkg --audit',
  'ls -1 /var/run/reboot-required.pkgs', 'lsb_release -a',
]

export default function Run() {
  const { user } = useAuthStore()
  const isAdmin = !!user?.is_admin
  const [serverList, setServerList] = useState<Server[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [command, setCommand] = useState('uptime')
  const [running, setRunning] = useState(false)
  const [grouped, setGrouped] = useState<{ output: string; servers: string[]; count: number }[] | null>(null)

  useEffect(() => {
    if (!isAdmin) return  // endpoint is admin-only; don't fetch for read-only users
    serversApi.list().then(s => setServerList(s.filter(x => x.is_enabled))).catch(() => {})
  }, [isAdmin])

  if (!isAdmin) {
    return (
      <div className="max-w-5xl mx-auto">
        <h1 className="text-lg font-mono text-text-primary mb-1">Fleet Command Runner</h1>
        <p className="text-sm text-text-muted">This page is available to administrators only.</p>
      </div>
    )
  }

  function toggle(id: number) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const allSelected = serverList.length > 0 && selected.size === serverList.length

  async function run() {
    if (selected.size === 0 || !command.trim()) return
    setRunning(true); setGrouped(null)
    try {
      const r = await serversApi.runCommand([...selected], command.trim())
      setGrouped(r.grouped)
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
    finally { setRunning(false) }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-mono text-text-primary mb-1">Fleet Command Runner</h1>
        <p className="text-sm text-text-muted">
          Run an allowlisted read-only command across selected servers and group identical outputs.
          Raw commands require <span className="font-mono">ENABLE_TERMINAL=true</span>. Every run is audited.
        </p>
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-64">
            <label className="label">Command</label>
            <input list="cmd-allow" className="input text-sm font-mono w-full" value={command} onChange={e => setCommand(e.target.value)} />
            <datalist id="cmd-allow">{ALLOWLISTED.map(c => <option key={c} value={c} />)}</datalist>
          </div>
          <button onClick={run} disabled={running || selected.size === 0} className="btn-primary text-sm">
            {running ? 'Running…' : `Run on ${selected.size}`}
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text-muted uppercase tracking-wide">Servers</span>
            <button onClick={() => setSelected(allSelected ? new Set() : new Set(serverList.map(s => s.id)))} className="text-xs text-cyan hover:underline">
              {allSelected ? 'Clear' : 'Select all'}
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1">
            {serverList.map(s => (
              <label key={s.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded border border-border/50 cursor-pointer hover:border-text-muted">
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} className="w-3.5 h-3.5 accent-green" />
                <span className="font-mono truncate">{s.name}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {grouped && (
        <div className="space-y-2">
          {grouped.length === 0 && <p className="text-text-muted text-sm">No output.</p>}
          {grouped.map((g, i) => (
            <div key={i} className="card overflow-hidden">
              <div className="px-3 py-1.5 border-b border-border bg-surface-2 text-xs font-mono flex items-center gap-2">
                <span className="text-text-primary">{g.count} server{g.count === 1 ? '' : 's'}</span>
                <span className="text-text-muted truncate">{g.servers.join(', ')}</span>
              </div>
              <pre className="px-3 py-2 font-mono text-xs text-text-primary whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">{g.output || '(no output)'}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
