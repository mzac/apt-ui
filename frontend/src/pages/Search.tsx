import { useState } from 'react'
import { Link } from 'react-router-dom'
import { servers as serversApi } from '@/api/client'

type Mode = 'exact' | 'contains' | 'starts-with' | 'ends-with' | 'regex'

type SearchResult = {
  servers: { id: number; name: string; hostname: string }[]
  matches: Record<string, Record<string, string>>  // pkg name → { server_id: version }
  errors: Record<string, string>
}

const MODE_LABELS: Record<Mode, string> = {
  contains: 'Contains',
  exact: 'Exact',
  'starts-with': 'Starts with',
  'ends-with': 'Ends with',
  regex: 'Regex',
}

const MODE_HELP: Record<Mode, string> = {
  contains: 'Match any package containing the substring (default)',
  exact: 'Match the package name exactly',
  'starts-with': 'Match packages whose name starts with the term',
  'ends-with': 'Match packages whose name ends with the term',
  regex: 'Python regex (matches anywhere in the name unless anchored)',
}

export default function Search() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>('contains')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOnlyDiverged, setShowOnlyDiverged] = useState(false)

  async function runSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await serversApi.searchPackage(query.trim(), mode)
      setResult(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  const allPackages = result ? Object.entries(result.matches).sort(([a], [b]) => a.localeCompare(b)) : []
  const filteredPackages = result
    ? allPackages.filter(([_, vers]) => {
        if (!showOnlyDiverged) return true
        const versionSet = new Set(Object.values(vers))
        return versionSet.size > 1
      })
    : []

  // Diverged count for the toggle label
  const divergedCount = allPackages.filter(([_, vers]) => new Set(Object.values(vers)).size > 1).length

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-lg font-mono text-text-primary mb-1">Fleet Package Search</h1>
      <p className="text-sm text-text-muted mb-5">
        Find which servers have a given package installed and at what version. Supports partial matching across the fleet.
      </p>

      <form onSubmit={runSearch} className="card p-4 mb-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={mode === 'regex' ? 'Regex pattern (e.g. ^linux-image-)' : 'Package name (e.g. openssl, python3)'}
            className="input flex-1 font-mono text-sm"
          />
          <select
            value={mode}
            onChange={e => setMode(e.target.value as Mode)}
            className="input text-sm w-36"
            title={MODE_HELP[mode]}
          >
            {(['contains', 'exact', 'starts-with', 'ends-with', 'regex'] as Mode[]).map(m => (
              <option key={m} value={m}>{MODE_LABELS[m]}</option>
            ))}
          </select>
          <button type="submit" disabled={!query.trim() || loading} className="btn-primary">
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Searching…
              </span>
            ) : 'Search'}
          </button>
        </div>
        <p className="text-xs text-text-muted">{MODE_HELP[mode]}</p>
      </form>

      {error && (
        <div className="card border-red/40 bg-red/5 p-3 mb-4 text-sm text-red font-mono">{error}</div>
      )}

      {result && (
        <>
          {/* Summary + filters */}
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <span className="text-xs text-text-muted font-mono">
              {allPackages.length.toLocaleString()} package{allPackages.length === 1 ? '' : 's'} matched across {result.servers.length} server{result.servers.length === 1 ? '' : 's'}
            </span>
            {divergedCount > 0 && (
              <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOnlyDiverged}
                  onChange={e => setShowOnlyDiverged(e.target.checked)}
                  className="w-3 h-3 accent-amber"
                />
                Show only diverged versions ({divergedCount})
              </label>
            )}
          </div>

          {/* Errors */}
          {Object.keys(result.errors).length > 0 && (
            <div className="card border-amber/40 bg-amber/5 p-3 mb-4">
              <div className="text-xs text-amber font-mono uppercase tracking-wide mb-1">SSH errors</div>
              {Object.entries(result.errors).map(([sid, msg]) => {
                const srv = result.servers.find(s => String(s.id) === sid)
                return (
                  <div key={sid} className="text-xs text-text-muted font-mono">
                    {srv?.name ?? `server #${sid}`}: {msg}
                  </div>
                )
              })}
            </div>
          )}

          {/* Pivot table — package as row, servers as columns */}
          {filteredPackages.length === 0 ? (
            <div className="card p-8 text-center text-text-muted text-sm">
              {allPackages.length === 0 ? 'No packages found.' : 'No diverged packages.'}
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-3 py-2 text-text-muted font-normal sticky left-0 bg-surface z-10 min-w-48">
                      Package
                    </th>
                    {result.servers.map(s => (
                      <th key={s.id} className="text-left px-3 py-2 text-text-muted font-normal whitespace-nowrap">
                        <Link to={`/servers/${s.id}`} className="hover:text-cyan">{s.name}</Link>
                        <div className="text-text-muted/60 font-mono text-[10px] font-normal">{s.hostname}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {filteredPackages.map(([name, versions]) => {
                    const versionSet = new Set(Object.values(versions))
                    const diverged = versionSet.size > 1
                    return (
                      <tr key={name} className={diverged ? 'bg-amber/5' : ''}>
                        <td className="px-3 py-1.5 text-text-primary sticky left-0 bg-inherit z-10">
                          {name}
                        </td>
                        {result.servers.map(s => {
                          const ver = versions[String(s.id)]
                          return (
                            <td key={s.id} className="px-3 py-1.5 whitespace-nowrap">
                              {ver ? (
                                <span className="text-text-primary">{ver}</span>
                              ) : (
                                <span className="text-text-muted/40">—</span>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
