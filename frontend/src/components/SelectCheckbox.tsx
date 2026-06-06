/**
 * Themed selection checkbox used for bulk server selection (Dashboard grid + list views).
 * Native checkboxes render as a white box that clashes with the dark theme, so this uses
 * `appearance-none` with theme tokens: dark `surface` fill + `border`, green when checked,
 * with a crisp white SVG checkmark overlay. Works in both dark and light themes.
 */
export default function SelectCheckbox({
  checked,
  onChange,
  label,
  className = '',
}: {
  checked: boolean
  onChange: () => void
  label: string
  className?: string
}) {
  return (
    <span
      className={`relative inline-flex w-3.5 h-3.5 shrink-0 ${className}`}
      onClick={e => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        title={label}
        className="peer appearance-none w-3.5 h-3.5 rounded-[3px] border border-border bg-surface cursor-pointer transition-colors hover:border-green/70 checked:bg-green checked:border-green focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green/60"
      />
      <svg
        viewBox="0 0 12 12"
        className="pointer-events-none absolute inset-0 m-auto h-3.5 w-3.5 p-[2px] text-white opacity-0 peer-checked:opacity-100"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 6.5 L5 9 L9.5 3.5" />
      </svg>
    </span>
  )
}
