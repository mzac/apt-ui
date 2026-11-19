import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    proxy: {
      // No changeOrigin: the backend refuses WebSockets whose Origin doesn't match
      // Host, so the proxy must pass the browser's Host through untouched.
      '/api': { target: 'http://localhost:8000', ws: true },
      '/health': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
})
