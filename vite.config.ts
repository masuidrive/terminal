import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies WebSocket and artifact HTTP to the backend.
// Backend listens on PORT (default 7681).
const BACKEND_PORT = Number(process.env.SERVER_PORT ?? 7681);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5172,
    strictPort: true,
    proxy: {
      '/ws': {
        target: `ws://localhost:${BACKEND_PORT}`,
        ws: true,
        rewriteWsOrigin: true,
      },
      '/api': `http://localhost:${BACKEND_PORT}`,
      '/artifacts': `http://localhost:${BACKEND_PORT}`,
    },
  },
});
