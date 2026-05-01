import { useState } from 'react'
import { Link } from 'react-router-dom'
import { servers as serversApi } from '@/api/client'

type SearchResult = {
  servers: { id: number; name: string; hostname: string }[]
  results: Record<string, { installed: boolean; version: string | null }>
  errors: Record<string, string>
}

type Filter = 'all' | 'installed' | 'missing'

export default function Search() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  async function runSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await serversApi.searchPackage(query.trim())
      setResult(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  // Group servers by installed/missing
  const visibleServers = result
    ? result.servers.filter(s => {
        const r = result.results[String(s.id)]
        if (filter === 'installed') return r?.installed
        if (filter === 'missing') return !r?.installed
        return true
      })
    : []

  const installedCount = result
    ? Object.values(result.results).filter(r => r.installed).length
    : 0
  const missingCount = result ? result.servers.length - installedCount : 0

  // Distinct versions among installed servers (highlight diverging installs)
  const versionSet = result
    ? new Set(
        Object.values(result.results)
          .filter(r => r.installed && r.version)
          .map(r => r.version!),
      )
    : new Set<string>()
  const hasMultipleVersions = versionSet.size > 1

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-lg font-mono text-text-primary mb-1">Fleet Package Search</h1>
      <p className="text-sm text-text-muted mb-5">
        Search for an installed package across all enabled servers. Useful for "is package X installed anywhere?"
        and "which version of package Y is each server running?".
      </p>

      <form onSubmit={runSearch} className="card p-4 mb-4 flex items-center gap-2">
        <input
          type="text"
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Package name (e.g. openssl, openssh-server)"
          className="input flex-1 font-mono text-sm"
        />
        <button type="submit" disabled={!query.trim() || loading} className="btn-primary">
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Searching…
            </span>
          ) : 'Search'}
        </button>
      </form>

      {error && (
        <div className="card border-red/40 bg-red/5 p-3 mb-4 text-sm text-red font-mono">{error}</div>
      )}

      {result && (
        <>
          {/* Summary */}
          <div className="flex items-center gap-3 mb-3">
            <div className="flex gap-1 text-xs font-mono">
              {(['all', 'installed', 'missing'] as Filter[]).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded border transition-colors ${
                    filter === f
                      ? 'border-green text-green bg-green/10'
                      : 'border-border text-text-muted hover:text-text-primary'
                  }`}
                >
                  {f === 'all' ? `All (${result.servers.length})`
                    : f === 'installed' ? `Installed (${installedCount})`
                    : `Missing (${missingCount})`}
                </button>
              ))}
            </div>
            {hasMultipleVersions && (
              <span className="text-xs font-mono text-amber" title="Multiple versions detected across the fleet">
                ⚠ {versionSet.size} different versions
              </span>
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

          {/* Results table */}
          <div className="card overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="text-left px-3 py-2 font-normal">Server</th>
                  <th className="text-left px-3 py-2 font-normal">Status</th>
                  <th className="text-left px-3 py-2 font-normal">Version</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {visibleServers.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-text-muted">
                      No servers match the current filter.
                    </td>
                  </tr>
                ) : (
                  visibleServers.map(s => {
                    const r = result.results[String(s.id)]
                    const installed = r?.installed
                    const ver = r?.version
                    // Highlight rows where this server's version differs from the majority
                    const isOdd = installed && hasMultipleVersions
                    return (
                      <tr key={s.id} className={isOdd ? 'bg-amber/5' : ''}>
                        <td className="px-3 py-1.5">
                          <Link to={`/servers/${s.id}`} className="text-cyan hover:underline">
                            {s.name}
                          </Link>
                          <span className="text-text-muted/60 ml-2 text-[10px]">{s.hostname}</span>
                        </td>
                        <td className="px-3 py-1.5">
                          {installed
                            ? <span className="text-green">✓ installed</span>
                            : <span className="text-text-muted/50">— not installed</span>}
                        </td>
                        <td className="px-3 py-1.5 text-text-primary">
                          {ver ?? <span className="text-text-muted/40">—</span>}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
