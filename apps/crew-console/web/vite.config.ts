import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Served by the Express daemon at /; `vite` dev on :5177 proxies the API to the running daemon.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { port: 5177, proxy: { '/api': { target: 'http://127.0.0.1:9900', changeOrigin: true } } },
})
