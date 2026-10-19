import { defineConfig } from 'vite';

// The room API (/api/room, WebSockets included) during local play: `npm run dev:rooms` serves it on 8787.
const proxy = { '/api': { target: 'http://127.0.0.1:8787', ws: true } };

// base './' so the build works from a GitHub Pages project subpath.
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  server: { proxy },
  preview: { proxy },
});
