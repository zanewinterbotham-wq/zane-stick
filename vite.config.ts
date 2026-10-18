import { defineConfig } from 'vite';

// base './' so the build works from a GitHub Pages project subpath.
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
});
