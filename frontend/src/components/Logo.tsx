/**
 * The apt-ui mark — a terminal prompt. Same artwork as `public/favicon.svg`, so the
 * browser tab, the header and the login screen all show one logo (issue #105).
 * Keep the two in step when changing either.
 */
export default function Logo({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="apt-ui"
    >
      <rect width="32" height="32" rx="6" fill="#0f1117" />
      <path d="M5 10 L12 16 L5 22" stroke="#22c55e" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <rect x="15" y="19" width="12" height="3" rx="1.2" fill="#22c55e" />
    </svg>
  )
}
