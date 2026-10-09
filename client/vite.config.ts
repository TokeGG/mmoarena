import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Dev: the browser talks to Vite, Vite forwards /ws and /api (replays, status) to the game server.
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true }, '/api': { target: 'http://localhost:8080' } },
  },
  optimizeDeps: { exclude: ['@arena/shared'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
