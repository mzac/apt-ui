import { useState, useEffect } from 'react'
import { servers as serversApi } from '@/api/client'
import type { Server } from '@/types'

type CompareResult = {
  servers: { id: number; name: string; hostname: string }[]
  packages: Record<string, Record<string, string | null>>
  errors: Record<string, string>
}

type Filter = 'all' | 'diff' | 'common'

export default function Compare() {
  const [serverList, setServerList] = useState<Server[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [result, setResult] = useState<CompareResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('diff')
  const [search, setSearch] = useState('')

  useEffect(() => {
    serversApi.list().then(setServerList).catch(() => {})
  }, [])

  function toggle(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
    setResult(null)
  }

  async function runCompare() {
    if (selectedIds.size < 2) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await serversApi.compare(Array.from(selectedIds))
      setResult(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Compare failed')
    } finally {
      setLoading(false)
    }
  }

  // Derive filtered package list
  const filteredPackages = result
    ? Object.entries(result.packages).filter(([name, versions]) => {
        const q = search.trim().toLowerCase()
        if (q && !name.toLowerCase().includes(q)) return false
        const vals = Object.values(versions)
        if (filter === 'diff') {
          const nonNull = vals.filter(v => v != null)
          return nonNull.length > 0 && nonNull.length < result.servers.length
        }
        if (filter === 'common') {
          return vals.every(v => v != null)
        }
        return true
      })
    : []

  const diffCount = result
    ? Object.values(result.packages).filter(versions => {
        const vals = Object.values(versions)
        const nonNull = vals.filter(v => v != null)
        return nonNull.length > 0 && nonNull.length < result.servers.length
      }).length
    : 0

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-lg font-mono text-text-primary mb-1">Package Comparison</h1>
      <p className="text-sm text-text-muted mb-5">
        Select two or more servers to compare their installed package lists side-by-side.
        Fetches live data via SSH — may take a few seconds per server.
      </p>

      {/* Server selection */}
      <div className="card p-4 mb-4">
        <div className="text-xs text-text-muted uppercase tracking-wide font-mono mb-3">
          Select servers to compare
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">
          {serverList.filter(s => s.is_enabled).map(s => (
            <label
              key={s.id}
              className={`flex items-center gap-2 px-3 py-2 rounded border cursor-pointer transition-colors ${
                selectedIds.has(s.id)
                  ? 'border-green bg-green/10'
                  : 'border-border hover:border-border/80 hover:bg-surface-2'
              }`}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(s.id)}
                onChange={() => toggle(s.id)}
                className="accent-green"
              />
              <div className="min-w-0">
                <div className="text-sm text-text-primary truncate">{s.name}</div>
                <div className="text-xs text-text-muted font-mono truncate">{s.hostname}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={runCompare}
            disabled={selectedIds.size < 2 || loading}
            className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Fetching…
              </span>
            ) : (
              `Compare ${selectedIds.size} server${selectedIds.size !== 1 ? 's' : ''}`
            )}
          </button>
          {selectedIds.size < 2 && (
            <span className="text-xs text-text-muted">Select at least 2 servers</span>
          )}
        </div>
      </div>

      {error && (
        <div className="card border-red/40 bg-red/5 p-3 mb-4 text-sm text-red font-mono">{error}</div>
      )}

      {result && (
        <>
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

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <div className="flex gap-1 text-xs font-mono">
              {(['diff', 'common', 'all'] as Filter[]).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded border transition-colors ${
                    filter === f
                      ? 'border-green text-green bg-green/10'
                      : 'border-border text-text-muted hover:text-text-primary'
                  }`}
                >
                  {f === 'diff' ? `Diverged (${diffCount})` : f === 'common' ? 'Common' : 'All'}
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Filter packages…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="input text-sm px-3 py-1 w-48"
            />
            <span className="text-xs text-text-muted font-mono ml-auto">
              {filteredPackages.length.toLocaleString()} packages
            </span>
          </div>

          {/* Table */}
          <div className="card overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-3 py-2 text-text-muted font-normal sticky left-0 bg-surface z-10 min-w-48">
                    Package
                  </th>
                  {result.servers.map(s => (
                    <th key={s.id} className="text-left px-3 py-2 text-text-muted font-normal whitespace-nowrap">
                      {s.name}
                      <div className="text-text-muted/60 font-mono text-[10px] font-normal">{s.hostname}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {filteredPackages.length === 0 ? (
                  <tr>
                    <td
                      colSpan={1 + result.servers.length}
                      className="px-3 py-8 text-center text-text-muted"
                    >
                      No packages match the current filter.
                    </td>
                  </tr>
                ) : (
                  filteredPackages.map(([name, versions]) => {
                    const presentCount = Object.values(versions).filter(v => v != null).length
                    const isDiff = presentCount < result.servers.length
                    return (
                      <tr key={name} className={isDiff ? 'bg-amber/5' : ''}>
                        <td className="px-3 py-1.5 text-text-primary sticky left-0 bg-inherit z-10">
                          {name}
                        </td>
                        {result.servers.map(s => {
                          const ver = versions[String(s.id)]
                          return (
                            <td key={s.id} className="px-3 py-1.5 whitespace-nowrap">
                              {ver != null ? (
                                <span className="text-text-primary">{ver}</span>
                              ) : (
                                <span className="text-text-muted/40">—</span>
                              )}
                            </td>
                          )
                        })}
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
