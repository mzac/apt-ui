import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { servers as serversApi, createInstallWebSocket } from '@/api/client'
import type { PackageSearchResult } from '@/types'
import Convert from 'ansi-to-html'

const ansiConvert = new Convert({ escapeXML: true })

interface Props {
  serverId: number
  serverName: string
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function PackageInstallModal({ serverId, serverName, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PackageSearchResult[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [termLines, setTermLines] = useState<string[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return }
    setSearching(true)
    try {
      const r = await serversApi.packageSearch(serverId, q.trim())
      setResults(r)
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [serverId])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(query), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, doSearch])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [termLines])

  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

  function toggleSelect(name: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function startInstall() {
    if (selected.size === 0) return
    setInstalling(true)
    setTermLines([])
    setDone(false)
    setError('')

    const ws = createInstallWebSocket(serverId, Array.from(selected), (msg) => {
      if (msg.type === 'output') {
        setTermLines(l => [...l, msg.data as string])
      } else if (msg.type === 'complete') {
        setDone(true)
        window.dispatchEvent(new CustomEvent('apt:refresh'))
      } else if (msg.type === 'error') {
        setError(msg.data as string)
        setDone(true)
      }
    }, () => {
      setInstalling(false)
    })
    wsRef.current = ws
  }

  function handleClose() {
    wsRef.current?.close()
    onClose()
  }

  const modal = (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">Install Packages — {serverName}</h2>
          {(!installing || done) && (
            <button onClick={handleClose} className="text-text-muted hover:text-red">✕</button>
          )}
        </div>

        {!installing ? (
          <div className="flex flex-col flex-1 overflow-hidden p-4 gap-3">
            {/* Search input */}
            <div className="relative">
              <input
                className="input w-full pr-8"
                placeholder="Search packages by name…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                autoFocus
              />
              {searching && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted text-xs animate-pulse">…</span>
              )}
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
              {results.length === 0 && query && !searching && (
                <p className="text-text-muted text-sm text-center py-4">No packages found for "{query}"</p>
              )}
              {results.map(pkg => {
                const isSel = selected.has(pkg.name)
                return (
                  <div
                    key={pkg.name}
                    onClick={() => toggleSelect(pkg.name)}
                    className={`px-3 py-2 rounded border cursor-pointer transition-colors ${
                      isSel
                        ? 'bg-green/10 border-green/40'
                        : 'bg-surface-2 border-border hover:border-text-muted'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleSelect(pkg.name)}
                          onClick={e => e.stopPropagation()}
                          className="w-4 h-4 accent-green shrink-0"
                        />
                        <span className="font-mono text-sm text-text-primary truncate">{pkg.name}</span>
                        {pkg.is_installed && (
                          <span className="badge text-xs bg-green/10 text-green border border-green/30 shrink-0">installed</span>
                        )}
                        {pkg.section && (
                          <span className="badge text-xs bg-surface-2 text-text-muted border border-border shrink-0">{pkg.section}</span>
                        )}
                      </div>
                      <div className="text-xs text-text-muted font-mono shrink-0 text-right">
                        {pkg.version && <div>{pkg.version}</div>}
                        {pkg.installed_size > 0 && <div>{formatSize(pkg.installed_size)}</div>}
                      </div>
                    </div>
                    {pkg.description && (
                      <p className="text-xs text-text-muted mt-1 truncate ml-6">{pkg.description}</p>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Install button */}
            <div className="flex items-center gap-3 pt-2 border-t border-border">
              <button
                onClick={startInstall}
                disabled={selected.size === 0}
                className="btn-primary"
              >
                Install Selected ({selected.size})
              </button>
              <button onClick={handleClose} className="btn-secondary">Cancel</button>
              {selected.size > 0 && (
                <div className="flex flex-wrap gap-1 ml-auto">
                  {Array.from(selected).map(n => (
                    <span
                      key={n}
                      className="badge text-xs bg-green/10 text-green border border-green/30 cursor-pointer"
                      onClick={() => toggleSelect(n)}
                    >
                      {n} ×
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col flex-1 p-4 gap-3 overflow-hidden">
            <div className="text-xs text-text-muted font-mono">
              Installing: {Array.from(selected).join(', ')}
            </div>
            <div
              ref={termRef}
              className="flex-1 overflow-y-auto bg-bg border border-border rounded p-2 font-mono text-xs text-text-primary min-h-0"
              style={{ maxHeight: '45vh' }}
            >
              {termLines.map((line, i) => (
                <div key={i} dangerouslySetInnerHTML={{ __html: ansiConvert.toHtml(line) }} />
              ))}
            </div>
            {error && (
              <div className="text-red text-xs font-mono px-2">✗ {error}</div>
            )}
            {done && (
              <button onClick={handleClose} className="btn-primary">Done</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
  return createPortal(modal, document.body)
}
