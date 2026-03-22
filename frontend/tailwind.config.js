/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['IBM Plex Sans', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      colors: {
        bg: '#0f1117',
        surface: '#1a1d27',
        'surface-2': '#242736',
        border: '#2e3347',
        'text-primary': '#e5e7eb',
        'text-muted': '#6b7280',
        green: '#22c55e',
        amber: '#f59e0b',
        red: '#ef4444',
        blue: '#3b82f6',
        cyan: '#06b6d4',
      },
    },
  },
  plugins: [],
}
