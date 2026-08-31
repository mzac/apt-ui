// Timestamp parsing helpers.
//
// The backend stores naive UTC and (historically) serialized it without a
// timezone marker. `new Date("2026-08-31T14:00:00")` parses an offset-less
// string as *local* time, which shifted every rendered timestamp by the
// viewer's UTC offset — "just now" for hours in UTC-negative zones, and
// literal negative ages ("-14341s ago") in the relative-time formatters.
//
// The backend now stamps UTC explicitly (see backend/timeutil.py). These
// helpers stay as a defensive parse so a missed endpoint, an older backend,
// or a cached response can't reintroduce the shift.
//
// Do NOT use these for timestamps read out of a remote host's logs
// (e.g. /var/log/dpkg.log) — those are that host's local wall clock, not UTC.

/** Parse a server timestamp, treating an offset-less string as UTC. */
export function parseServerDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  // Already carries a zone designator (Z, +HH:MM, -HH:MM after the time part)?
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim())
  const d = new Date(hasZone ? iso : `${iso}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Milliseconds elapsed since a server timestamp; null when unparseable. */
export function ageMs(iso: string | null | undefined): number | null {
  const d = parseServerDate(iso)
  return d ? Date.now() - d.getTime() : null
}

/** Compact relative age, e.g. "just now", "12m ago", "3h ago", "5d ago". */
export function relativeTime(iso: string | null | undefined): string {
  const diff = ageMs(iso)
  if (diff === null) return '—'
  // Small negative skew (server clock slightly ahead) reads as "just now".
  if (diff < 60_000) return 'just now'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** True when the timestamp is older than `hours` (missing/unparseable = not stale). */
export function isStale(iso: string | null | undefined, hours = 24): boolean {
  const diff = ageMs(iso)
  return diff !== null && diff > hours * 3600_000
}

/** Locale date+time for a server timestamp, or a dash. */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parseServerDate(iso)
  return d ? d.toLocaleString() : '—'
}

/** Locale date (no time) for a server timestamp, or a dash. */
export function formatDate(iso: string | null | undefined): string {
  const d = parseServerDate(iso)
  return d ? d.toLocaleDateString() : '—'
}
