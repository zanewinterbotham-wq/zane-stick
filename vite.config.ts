import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// The release id multiplayer players must share (src/game/net/version.ts): the commit built.
const build = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'dev'; } })();

// The room API (/api/room, WebSockets included) during local play: `npm run dev:rooms` serves it on 8787.
const proxy = { '/api': { target: 'http://127.0.0.1:8787', ws: true } };

// base './' so the build works from a GitHub Pages project subpath.
export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(build) },
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  server: { proxy },
  preview: { proxy },
});
