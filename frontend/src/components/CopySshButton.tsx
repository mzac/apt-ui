import { useState } from 'react'

interface Props {
  username: string
  hostname: string
  port?: number
  className?: string
}

/**
 * Copies `ssh user@host -p port` (port omitted if 22) to the clipboard on click.
 * Briefly shows a "copied" indicator. Falls back to document.execCommand for
 * browsers without navigator.clipboard.
 */
export default function CopySshButton({ username, hostname, port = 22, className }: Props) {
  const [copied, setCopied] = useState(false)

  function buildCmd() {
    return port === 22
      ? `ssh ${username}@${hostname}`
      : `ssh ${username}@${hostname} -p ${port}`
  }

  async function copy(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const cmd = buildCmd()
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(cmd)
      } else {
        const ta = document.createElement('textarea')
        ta.value = cmd
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Silent fail — clipboard access may be blocked
    }
  }

  return (
    <button
      onClick={copy}
      title={copied ? 'Copied!' : `Copy: ${buildCmd()}`}
      className={`inline-flex items-center justify-center text-text-muted hover:text-cyan transition-colors ${className ?? ''}`}
    >
      {copied ? (
        <span className="text-green text-xs">✓</span>
      ) : (
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path d="M4 1.5A1.5 1.5 0 0 1 5.5 0h7A1.5 1.5 0 0 1 14 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10v-1h2.5a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5V4H4V1.5z" />
          <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h7A1.5 1.5 0 0 1 12 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 14.5v-9zm1.5-.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-7z" />
        </svg>
      )}
    </button>
  )
}
