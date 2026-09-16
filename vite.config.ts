import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ base: './', plugins: [react(), tailwindcss(), {
  name: 'development-refresh-csp', apply: 'serve',
  // The dev server may fall back from 5173 to another free port; allow its HMR socket on any local port.
  transformIndexHtml: html => html
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace('ws://127.0.0.1:5173', 'ws://127.0.0.1:*'),
}], server: {host: '127.0.0.1', port: 5173} });
