import clsx from 'clsx'
import type { ServerStatus } from '@/types'

const colors: Record<ServerStatus, string> = {
  up_to_date: 'bg-green',
  updates_available: 'bg-amber',
  error: 'bg-red',
  checking: 'bg-blue animate-pulse',
  upgrading: 'bg-cyan animate-pulse',
  disabled: 'bg-gray-600',
  unknown: 'bg-gray-600',
}

export default function StatusDot({ status, size = 'sm' }: { status: ServerStatus; size?: 'sm' | 'md' }) {
  return (
    <span
      className={clsx(
        'inline-block rounded-full flex-shrink-0',
        colors[status],
        size === 'sm' ? 'w-2 h-2' : 'w-3 h-3',
      )}
    />
  )
}
