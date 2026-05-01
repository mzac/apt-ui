import { useEffect, useState } from 'react'
import { reports as reportsApi } from '@/api/client'

type ReportTab = 'coverage' | 'success' | 'sla'

function downloadCsv(filename: string, headers: string[], rows: (string | number | boolean | null)[][]) {
  const escape = (v: string | number | boolean | null) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function Reports() {
  const [tab, setTab] = useState<ReportTab>('coverage')

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-mono text-text-primary">Reports</h1>
        <p className="text-sm text-text-muted">Compliance and SLA reports for audit / regulatory needs.</p>
      </div>

      <div className="flex gap-1 border-b border-border">
        {(
          [
            { id: 'coverage', label: 'Patch Coverage' },
            { id: 'success', label: 'Upgrade Success Rate' },
            { id: 'sla', label: 'Security SLA' },
          ] as { id: ReportTab; label: string }[]
        ).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm transition-colors -mb-px border-b-2 ${
              tab === t.id ? 'border-green text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'coverage' && <PatchCoverageReport />}
      {tab === 'success' && <UpgradeSuccessReport />}
      {tab === 'sla' && <SecuritySlaReport />}
    </div>
  )
}

function PatchCoverageReport() {
  const [data, setData] = useState<Awaited<ReturnType<typeof reportsApi.patchCoverage>> | null>(null)
  useEffect(() => { reportsApi.patchCoverage().then(setData).catch(() => {}) }, [])
  if (!data) return <p className="text-text-muted text-sm">Loading…</p>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Checked in 24h', pct: data.summary.pct_24h, count: data.summary.checked_in_24h },
          { label: 'Checked in 7 days', pct: data.summary.pct_7d, count: data.summary.checked_in_7d },
          { label: 'Checked in 30 days', pct: data.summary.pct_30d, count: data.summary.checked_in_30d },
        ].map(c => (
          <div key={c.label} className="card p-4">
            <div className="text-xs text-text-muted uppercase tracking-wide">{c.label}</div>
            <div className="text-2xl font-mono text-text-primary mt-1">{c.pct}%</div>
            <div className="text-xs text-text-muted">{c.count} of {data.total_enabled_servers} servers</div>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => downloadCsv(
            `patch-coverage-${new Date().toISOString().slice(0, 10)}.csv`,
            ['Server', 'Hostname', 'Last Check', '24h', '7d', '30d'],
            data.servers.map(s => [s.server, s.hostname, s.last_check, s.in_24h, s.in_7d, s.in_30d]),
          )}
          className="btn-secondary text-xs"
        >
          ↓ Download CSV
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="text-left px-3 py-2 font-normal">Server</th>
              <th className="text-left px-3 py-2 font-normal">Last Check</th>
              <th className="text-center px-3 py-2 font-normal">24h</th>
              <th className="text-center px-3 py-2 font-normal">7d</th>
              <th className="text-center px-3 py-2 font-normal">30d</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {data.servers.map(s => (
              <tr key={s.hostname} className="hover:bg-surface/50">
                <td className="px-3 py-1.5 text-text-primary">{s.server}</td>
                <td className="px-3 py-1.5 text-text-muted">{s.last_check ? new Date(s.last_check).toLocaleString() : '—'}</td>
                <td className="px-3 py-1.5 text-center">{s.in_24h ? '✓' : '—'}</td>
                <td className="px-3 py-1.5 text-center">{s.in_7d ? '✓' : '—'}</td>
                <td className="px-3 py-1.5 text-center">{s.in_30d ? '✓' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function UpgradeSuccessReport() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Awaited<ReturnType<typeof reportsApi.upgradeSuccessRate>> | null>(null)
  useEffect(() => { reportsApi.upgradeSuccessRate(days).then(setData).catch(() => {}) }, [days])
  if (!data) return <p className="text-text-muted text-sm">Loading…</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-xs text-text-muted">Window:</label>
        <select value={days} onChange={e => setDays(parseInt(e.target.value))} className="input text-sm w-24">
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
        </select>
        <span className="text-xs text-text-muted">
          Overall: {data.summary.overall_rate ?? '—'}% ({data.summary.total_success} ok / {data.summary.total_error} fail)
        </span>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => downloadCsv(
            `upgrade-success-${days}d-${new Date().toISOString().slice(0, 10)}.csv`,
            ['Server', 'Hostname', 'Success', 'Error', 'Running', 'Success Rate %'],
            data.servers.map(s => [s.server, s.hostname, s.success, s.error, s.running, s.success_rate ?? '']),
          )}
          className="btn-secondary text-xs"
        >
          ↓ Download CSV
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="text-left px-3 py-2 font-normal">Server</th>
              <th className="text-right px-3 py-2 font-normal">Success</th>
              <th className="text-right px-3 py-2 font-normal">Error</th>
              <th className="text-right px-3 py-2 font-normal">Running</th>
              <th className="text-right px-3 py-2 font-normal">Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {data.servers.map(s => (
              <tr key={s.hostname} className="hover:bg-surface/50">
                <td className="px-3 py-1.5 text-text-primary">{s.server}</td>
                <td className="px-3 py-1.5 text-right text-green">{s.success}</td>
                <td className="px-3 py-1.5 text-right text-red">{s.error}</td>
                <td className="px-3 py-1.5 text-right text-cyan">{s.running}</td>
                <td className="px-3 py-1.5 text-right text-text-primary">{s.success_rate ?? '—'}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SecuritySlaReport() {
  const [slaDays, setSlaDays] = useState(7)
  const [windowDays, setWindowDays] = useState(90)
  const [data, setData] = useState<Awaited<ReturnType<typeof reportsApi.securitySla>> | null>(null)
  useEffect(() => { reportsApi.securitySla(slaDays, windowDays).then(setData).catch(() => {}) }, [slaDays, windowDays])
  if (!data) return <p className="text-text-muted text-sm">Loading…</p>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-text-muted">SLA:</label>
        <select value={slaDays} onChange={e => setSlaDays(parseInt(e.target.value))} className="input text-sm w-24">
          <option value={1}>1 day</option>
          <option value={3}>3 days</option>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
        <label className="text-xs text-text-muted">Window:</label>
        <select value={windowDays} onChange={e => setWindowDays(parseInt(e.target.value))} className="input text-sm w-24">
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={180}>180 days</option>
        </select>
        <span className="text-xs text-text-muted ml-auto">
          {data.summary.pct_in_sla}% in SLA · {data.summary.in_sla} ok / {data.summary.out_of_sla} late · {data.summary.no_security_seen} clean
        </span>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => downloadCsv(
            `security-sla-${new Date().toISOString().slice(0, 10)}.csv`,
            ['Server', 'Hostname', 'First Security Seen', 'Cleared At', 'Days to Clear', 'In SLA'],
            data.servers.map(s => [s.server, s.hostname, s.first_security_seen, s.cleared_at, s.days_to_clear ?? '', s.in_sla ?? '']),
          )}
          className="btn-secondary text-xs"
        >
          ↓ Download CSV
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="text-left px-3 py-2 font-normal">Server</th>
              <th className="text-left px-3 py-2 font-normal">First seen</th>
              <th className="text-left px-3 py-2 font-normal">Cleared</th>
              <th className="text-right px-3 py-2 font-normal">Days to clear</th>
              <th className="text-center px-3 py-2 font-normal">In SLA</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {data.servers.map(s => (
              <tr key={s.hostname} className="hover:bg-surface/50">
                <td className="px-3 py-1.5 text-text-primary">{s.server}</td>
                <td className="px-3 py-1.5 text-text-muted">{s.first_security_seen ? new Date(s.first_security_seen).toLocaleDateString() : '—'}</td>
                <td className="px-3 py-1.5 text-text-muted">{s.cleared_at ? new Date(s.cleared_at).toLocaleDateString() : (s.first_security_seen ? <span className="text-amber">still pending</span> : '—')}</td>
                <td className="px-3 py-1.5 text-right text-text-primary">{s.days_to_clear ?? '—'}</td>
                <td className="px-3 py-1.5 text-center">
                  {s.in_sla === null ? '—' : s.in_sla ? <span className="text-green">✓</span> : <span className="text-red">✗</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
