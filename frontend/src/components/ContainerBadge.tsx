/**
 * Small "LXC" / "DOCKER" badge for servers that are containers rather than
 * full machines (issue #101).
 *
 * A container shares its host's kernel, so some of what apt-ui shows about it
 * — kernel version, reboot-required, uptime — really describes the host.
 * The backend reports `virt_type` as "container (<runtime>)" for these
 * (see update_checker.py); VMs and bare metal get no badge.
 */
export function containerRuntime(virtType: string | null | undefined): string | null {
  const m = /^container \((.+)\)$/.exec(virtType ?? '')
  return m ? m[1] : null
}

export default function ContainerBadge({ virtType, className = '' }: { virtType: string | null | undefined; className?: string }) {
  const runtime = containerRuntime(virtType)
  if (!runtime) return null
  return (
    <span
      className={`inline-block shrink-0 px-1 rounded border border-blue/40 bg-blue/10 text-blue text-[10px] leading-4 font-mono uppercase ${className}`}
      title={`${runtime} container — shares its host's kernel`}
    >
      {runtime}
    </span>
  )
}
