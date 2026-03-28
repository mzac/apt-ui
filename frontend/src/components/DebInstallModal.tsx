import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import Convert from 'ansi-to-html'
import { servers as serversApi, createInstallDebWebSocket } from '@/api/client'

const ansiConvert = new Convert({ escapeXML: true })

type Mode = 'url' | 'upload'
type Phase = 'idle' | 'validating' | 'validated' | 'uploading' | 'running' | 'done'

interface Props {
  serverId: number
  onClose: () => void
}

export default function DebInstallModal({ serverId, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('url')

  // URL mode state
  const [url, setUrl] = useState('')
  const [validationResult, setValidationResult] = useState<{
    valid: boolean; filename?: string; content_length?: number | null; error?: string
  } | null>(null)

  // Upload mode state
  const [file, setFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [success, setSuccess] = useState<boolean | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [lines])

  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

  function handleClose() {
    wsRef.current?.close()
    onClose()
  }

  async function handleValidate() {
    if (!url.trim()) return
    setPhase('validating')
    setValidationResult(null)
    try {
      const result = await serversApi.validateDebUrl(serverId, url.trim())
      setValidationResult(result)
      setPhase(result.valid ? 'validated' : 'idle')
    } catch (e: unknown) {
      setValidationResult({ valid: false, error: String(e) })
      setPhase('idle')
    }
  }

  function startInstallFromUrl() {
    if (!validationResult?.valid) return
    setPhase('running')
    setLines([])
    setSuccess(null)
    setStatusMsg('Connecting…')

    wsRef.current = createInstallDebWebSocket(
      serverId,
      { source: 'url', url: url.trim() },
      (msg) => {
        if (msg.type === 'status') {
          const s = msg.data as string
          if (s === 'downloading') setStatusMsg('Downloading…')
          else if (s === 'installing') setStatusMsg('Installing with dpkg…')
          else if (s === 'fixing_deps') setStatusMsg('Fixing dependencies…')
        } else if (msg.type === 'output') {
          setLines(prev => [...prev, msg.data as string])
        } else if (msg.type === 'error') {
          setLines(prev => [...prev, `ERROR: ${msg.data}`])
          setPhase('done')
          setSuccess(false)
        } else if (msg.type === 'complete') {
          const ok = (msg.data as Record<string, unknown>).success as boolean
          setSuccess(ok)
          setStatusMsg(ok ? 'Installation complete' : 'Installation failed')
          setPhase('done')
        }
      },
    )
  }

  async function handleUploadAndInstall() {
    if (!file) return
    setPhase('uploading')
    setUploadProgress('Uploading to server…')
    setLines([])
    setSuccess(null)

    let remotePath: string
    try {
      const result = await serversApi.uploadDeb(serverId, file)
      remotePath = result.remote_path
      setUploadProgress(null)
    } catch (e: unknown) {
      setUploadProgress(null)
      setLines([`Upload failed: ${e}`])
      setPhase('done')
      setSuccess(false)
      return
    }

    setPhase('running')
    setStatusMsg('Installing…')

    wsRef.current = createInstallDebWebSocket(
      serverId,
      { source: 'remote', path: remotePath },
      (msg) => {
        if (msg.type === 'status') {
          const s = msg.data as string
          if (s === 'installing') setStatusMsg('Installing with dpkg…')
          else if (s === 'fixing_deps') setStatusMsg('Fixing dependencies…')
        } else if (msg.type === 'output') {
          setLines(prev => [...prev, msg.data as string])
        } else if (msg.type === 'error') {
          setLines(prev => [...prev, `ERROR: ${msg.data}`])
          setPhase('done')
          setSuccess(false)
        } else if (msg.type === 'complete') {
          const ok = (msg.data as Record<string, unknown>).success as boolean
          setSuccess(ok)
          setStatusMsg(ok ? 'Installation complete' : 'Installation failed')
          setPhase('done')
        }
      },
    )
  }

  const busy = phase === 'validating' || phase === 'uploading' || phase === 'running'

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface border border-border rounded-lg w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text-primary">Install .deb Package</h2>
          <button onClick={handleClose} className="text-text-muted hover:text-text-primary text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Mode tabs — only shown while not running */}
          {phase !== 'running' && phase !== 'done' && (
            <div className="flex gap-2 border-b border-border">
              {(['url', 'upload'] as Mode[]).map(m => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setValidationResult(null); setFile(null) }}
                  disabled={busy}
                  className={`px-4 py-2 text-sm -mb-px border-b-2 transition-colors ${
                    mode === m ? 'border-green text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
                  }`}
                >
                  {m === 'url' ? 'From URL' : 'Upload File'}
                </button>
              ))}
            </div>
          )}

          {/* URL mode */}
          {mode === 'url' && phase !== 'running' && phase !== 'done' && (
            <div className="space-y-3">
              <p className="text-xs text-text-muted">
                Enter a direct URL to a <code className="bg-black/30 px-1 rounded">.deb</code> file.
                The remote server will download it with <code className="bg-black/30 px-1 rounded">wget</code>.
              </p>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={url}
                  onChange={e => { setUrl(e.target.value); setValidationResult(null); setPhase('idle') }}
                  placeholder="https://example.com/package_1.0_amd64.deb"
                  disabled={busy}
                  className="flex-1 bg-bg border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-green"
                />
                <button
                  onClick={handleValidate}
                  disabled={busy || !url.trim()}
                  className="px-3 py-1.5 text-sm bg-surface border border-border rounded hover:border-green disabled:opacity-50 text-text-primary"
                >
                  {phase === 'validating' ? 'Checking…' : 'Validate'}
                </button>
              </div>

              {validationResult && (
                <div className={`rounded px-3 py-2 text-xs ${validationResult.valid ? 'bg-green/10 border border-green/30 text-green' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>
                  {validationResult.valid ? (
                    <>
                      <span className="font-medium">✓ Valid</span>
                      {' — '}{validationResult.filename}
                      {validationResult.content_length != null && (
                        <> ({(validationResult.content_length / 1024 / 1024).toFixed(1)} MB)</>
                      )}
                    </>
                  ) : (
                    <><span className="font-medium">✗</span> {validationResult.error}</>
                  )}
                </div>
              )}

              <button
                onClick={startInstallFromUrl}
                disabled={!validationResult?.valid || busy}
                className="w-full py-2 text-sm font-medium bg-green text-black rounded hover:bg-green/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Download &amp; Install
              </button>
            </div>
          )}

          {/* Upload mode */}
          {mode === 'upload' && phase !== 'running' && phase !== 'done' && (
            <div className="space-y-3">
              <p className="text-xs text-text-muted">
                Select a <code className="bg-black/30 px-1 rounded">.deb</code> file to upload directly to the server via SFTP, then install it.
              </p>
              <label className="block">
                <input
                  type="file"
                  accept=".deb"
                  onChange={e => setFile(e.target.files?.[0] ?? null)}
                  disabled={busy}
                  className="block w-full text-sm text-text-muted file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-border file:text-xs file:bg-surface file:text-text-primary hover:file:border-green cursor-pointer"
                />
              </label>
              {file && (
                <p className="text-xs text-text-muted">
                  {file.name} — {(file.size / 1024 / 1024).toFixed(1)} MB
                </p>
              )}
              {uploadProgress && (
                <p className="text-xs text-amber-400 animate-pulse">{uploadProgress}</p>
              )}
              <button
                onClick={handleUploadAndInstall}
                disabled={!file || busy}
                className="w-full py-2 text-sm font-medium bg-green text-black rounded hover:bg-green/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Upload &amp; Install
              </button>
            </div>
          )}

          {/* Terminal output */}
          {(phase === 'running' || phase === 'done' || lines.length > 0) && (
            <div className="space-y-2">
              {phase === 'running' && (
                <div className="flex items-center gap-2 text-xs text-amber-400">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  {statusMsg}
                </div>
              )}
              {phase === 'done' && success !== null && (
                <div className={`text-xs font-medium ${success ? 'text-green' : 'text-red-400'}`}>
                  {success ? '✓ ' : '✗ '}{statusMsg}
                </div>
              )}
              <div
                ref={termRef}
                className="bg-black rounded p-3 h-64 overflow-y-auto font-mono text-xs leading-relaxed"
                dangerouslySetInnerHTML={{
                  __html: lines.map(l => ansiConvert.toHtml(l)).join('')
                }}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border shrink-0 flex justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 text-sm bg-surface border border-border rounded hover:border-green text-text-primary"
          >
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
