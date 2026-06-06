import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { toast } from '@/hooks/useToast'
import type { Server } from '@/types'

interface Props {
  server: Server
  onClose: () => void
}

// dpkg/ucf leave the maintainer's new config next to the live one with these suffixes.
const SUFFIXES = ['.dpkg-dist', '.dpkg-new', '.ucf-dist', '.dpkg-old']

/** The live config file that a leftover shadows (strip the suffix). */
function livePath(leftover: string): string {
  for (const s of SUFFIXES) {
    if (leftover.endsWith(s)) return leftover.slice(0, -s.length)
  }
  return leftover
}

async function copy(text: string, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch (e) {
    toast.error(`Copy failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export default function DriftModal({ server, onClose }: Props) {
  useEscapeKey(onClose, true)

  const files = server.drift_files ?? []
  const count = server.drift_count ?? files.length
  const diffCommands = files.map(f => `diff ${livePath(f)} ${f}`).join('\n')
  const rmCommands = files.map(f => `rm ${f}`).join('\n')

  const modal = (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) { e.stopPropagation(); onClose() } }}
    >
      <div
        className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-sm text-text-primary">
            <span className="text-amber">⚠ Config drift</span> — {server.name}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-red" aria-label="Close">✕</button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto flex flex-col gap-3 text-sm">
          <p className="text-text-muted leading-relaxed">
            <span className="text-text-primary font-mono">{count}</span> unmerged conffile{count === 1 ? '' : 's'} under{' '}
            <code className="text-text-primary">/etc</code>, as of the last check. An upgrade shipped a new default
            config, but your modified version was kept (the <code className="text-text-primary">confdef/confold</code>{' '}
            policy) — so the maintainer's new version is sitting <em>unapplied</em> right next to your live file.
            Usually harmless, but a missing new directive can bite on the next service restart.
          </p>

          {files.length > 0 ? (
            <>
              <div className="border border-border rounded divide-y divide-border/60">
                {files.map(f => (
                  <div key={f} className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-xs">
                    <span className="flex-1 min-w-0 break-all">
                      <span className="text-amber">{f}</span>
                      <span className="text-text-muted block">shadows {livePath(f)}</span>
                    </span>
                    <button
                      onClick={() => copy(`diff ${livePath(f)} ${f}`, 'diff command copied')}
                      className="btn-secondary text-[10px] py-0.5 shrink-0"
                      title="Copy the diff command for this file"
                    >
                      Copy diff
                    </button>
                  </div>
                ))}
                {count > files.length && (
                  <div className="px-2.5 py-1.5 text-[11px] text-text-muted font-mono">
                    + {count - files.length} more (list capped at {files.length})
                  </div>
                )}
              </div>

              <div className="text-text-muted text-xs leading-relaxed">
                To reconcile each: review the diff, merge anything you want into the live file, then delete the
                leftover (<code className="text-text-primary">rm</code>). The leftover is the file with the suffix.
              </div>

              <div className="flex gap-2 flex-wrap">
                <button onClick={() => copy(diffCommands, `${files.length} diff command(s) copied`)} className="btn-secondary text-xs">
                  Copy all diff commands
                </button>
                <button onClick={() => copy(rmCommands, `${files.length} rm command(s) copied`)} className="btn-secondary text-xs">
                  Copy all rm commands
                </button>
              </div>
            </>
          ) : (
            <div className="text-text-muted text-xs leading-relaxed border border-border rounded p-3">
              The specific file paths weren't captured in the last check (older data). Run <strong className="text-text-primary">Check</strong> on
              this server to populate them, or list them over SSH:
              <pre className="mt-2 bg-bg rounded p-2 overflow-x-auto text-text-primary">
                find /etc \( -name '*.dpkg-dist' -o -name '*.ucf-dist' -o -name '*.dpkg-new' \)
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
