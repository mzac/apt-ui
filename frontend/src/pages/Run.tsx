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

// Saved presets and the previous run's grouped output, per user-agent. Presets are
// a convenience, and the snapshot only powers the "changed since last run" hint —
// neither is authoritative state, so localStorage is the right home and a parse
// failure must never take the page down.
const PRESETS_KEY = 'run:presets'
const LAST_RUN_KEY = 'run:lastRun'

interface Group { output: string; servers: string[]; count: number }
interface LastRun { command: string; at: number; byServer: Record<string, string> }

function loadPresets(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : []
  } catch { return [] }
}

function loadLastRun(): LastRun | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_RUN_KEY) || 'null')
    if (raw && typeof raw.command === 'string' && raw.byServer && typeof raw.byServer === 'object') {
      return raw as LastRun
    }
  } catch { /* ignore malformed snapshot */ }
  return null
}

// Flatten grouped output back to one entry per server so two runs can be compared
// server-by-server (grouping order is not stable between runs).
function flatten(groups: Group[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const g of groups) for (const s of g.servers) out[s] = g.output
  return out
}

export default function Run() {
  const { user } = useAuthStore()
  const isAdmin = !!user?.is_admin
  const [serverList, setServerList] = useState<Server[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [command, setCommand] = useState('uptime')
  const [running, setRunning] = useState(false)
  const [grouped, setGrouped] = useState<Group[] | null>(null)
  const [presets, setPresets] = useState<string[]>(loadPresets)
  // Snapshot of the previous run of the SAME command, captured before this run
  // overwrites it — this is what "changed" badges are compared against.
  const [baseline, setBaseline] = useState<LastRun | null>(null)

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

  function persistPresets(next: string[]) {
    setPresets(next)
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)) } catch { /* quota/private mode */ }
  }

  function savePreset() {
    const c = command.trim()
    if (!c || presets.includes(c)) return
    persistPresets([...presets, c])
    toast.success('Preset saved')
  }

  async function run() {
    if (selected.size === 0 || !command.trim()) return
    const cmd = command.trim()
    // Capture the prior snapshot for THIS command before overwriting it.
    const prev = loadLastRun()
    setBaseline(prev && prev.command === cmd ? prev : null)
    setRunning(true); setGrouped(null)
    try {
      const r = await serversApi.runCommand([...selected], cmd)
      setGrouped(r.grouped)
      try {
        localStorage.setItem(LAST_RUN_KEY, JSON.stringify({
          command: cmd, at: Date.now(), byServer: flatten(r.grouped),
        } satisfies LastRun))
      } catch { /* quota/private mode — the diff hint is best-effort */ }
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
    finally { setRunning(false) }
  }

  // Servers whose output differs from the previous run of the same command.
  const changedServers = (() => {
    if (!grouped || !baseline) return new Set<string>()
    const now = flatten(grouped)
    const changed = new Set<string>()
    for (const [name, out] of Object.entries(now)) {
      if (name in baseline.byServer && baseline.byServer[name] !== out) changed.add(name)
    }
    return changed
  })()

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
          <button onClick={savePreset} disabled={!command.trim() || presets.includes(command.trim())} className="btn-secondary text-sm" title="Save this command as a preset">
            ☆ Save preset
          </button>
          <button onClick={run} disabled={running || selected.size === 0} className="btn-primary text-sm">
            {running ? 'Running…' : `Run on ${selected.size}`}
          </button>
        </div>

        {presets.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-text-muted uppercase tracking-wide mr-1">Presets</span>
            {presets.map(p => (
              <span key={p} className="inline-flex items-center gap-1 badge bg-cyan/10 text-cyan border border-cyan/30 text-xs font-mono pl-2 pr-1 py-0.5">
                <button onClick={() => setCommand(p)} className="hover:underline" title="Use this command">{p}</button>
                <button
                  onClick={() => persistPresets(presets.filter(x => x !== p))}
                  className="text-text-muted hover:text-red px-1"
                  title="Remove preset"
                  aria-label={`Remove preset ${p}`}
                >×</button>
              </span>
            ))}
          </div>
        )}

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
          {baseline && (
            <p className="text-xs text-text-muted">
              {changedServers.size === 0
                ? 'No output changed since the previous run of this command.'
                : `${changedServers.size} server${changedServers.size === 1 ? '' : 's'} changed since the previous run.`}
            </p>
          )}
          {grouped.length === 0 && <p className="text-text-muted text-sm">No output.</p>}
          {grouped.map((g, i) => (
            <div key={i} className="card overflow-hidden">
              <div className="px-3 py-1.5 border-b border-border bg-surface-2 text-xs font-mono flex items-center gap-2">
                <span className="text-text-primary">{g.count} server{g.count === 1 ? '' : 's'}</span>
                <span className="text-text-muted truncate">
                  {g.servers.map((name, j) => (
                    <span key={name}>
                      {j > 0 && ', '}
                      <span className={changedServers.has(name) ? 'text-amber' : undefined}
                            title={changedServers.has(name) ? 'Output changed since the previous run' : undefined}>
                        {name}{changedServers.has(name) ? ' •' : ''}
                      </span>
                    </span>
                  ))}
                </span>
              </div>
              <pre className="px-3 py-2 font-mono text-xs text-text-primary whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">{g.output || '(no output)'}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
