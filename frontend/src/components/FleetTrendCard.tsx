import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { stats as statsApi, type FleetTrendPoint } from '@/api/client'

// Fleet trend over time, from persisted FleetSnapshot rows (written after each
// scheduled check-all). Hidden until there are at least two data points.
export default function FleetTrendCard() {
  const [points, setPoints] = useState<FleetTrendPoint[]>([])

  useEffect(() => {
    statsApi.trend(30).then(r => setPoints(r.points)).catch(() => {})
  }, [])

  if (points.length < 2) return null

  const data = points.map(p => ({
    date: new Date(p.recorded_at).toLocaleDateString(),
    pending: p.pending_packages_total,
    security: p.security_packages_total,
    pct: p.pct_up_to_date ?? 0,
  }))

  return (
    <div className="card p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs text-text-muted uppercase tracking-wide">Fleet trend (30d)</h3>
        <div className="flex items-center gap-3 text-[10px] text-text-muted font-mono">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: '#f59e0b' }} />pending</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: '#ef4444' }} />security</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: '#22c55e' }} />% up-to-date</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data}>
          <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 11 }} />
          <YAxis yAxisId="left" tick={{ fill: '#6b7280', fontSize: 11 }} allowDecimals={false} />
          <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fill: '#6b7280', fontSize: 11 }} />
          <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2e3347', borderRadius: '4px', fontSize: '12px' }} labelStyle={{ color: '#e5e7eb' }} />
          <Line yAxisId="left" type="monotone" dataKey="pending" name="pending" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
          <Line yAxisId="left" type="monotone" dataKey="security" name="security" stroke="#ef4444" dot={false} strokeWidth={1.5} />
          <Line yAxisId="right" type="monotone" dataKey="pct" name="% up-to-date" stroke="#22c55e" dot={false} strokeWidth={1.5} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
