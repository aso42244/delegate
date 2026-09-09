import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  /*
   * Where this build is served from, baked into the asset URLs in index.html.
   *
   * `/` for every ordinary deployment. A demo mounted under a path on somebody
   * else's domain sets `VITE_BASE_PATH=/demo/`, and the trailing slash matters:
   * Vite joins it to asset names directly.
   */
  base: process.env['VITE_BASE_PATH'] ?? '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API runs separately in development. In production the API serves this
    // build directly, so the same relative /api paths work in both.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
