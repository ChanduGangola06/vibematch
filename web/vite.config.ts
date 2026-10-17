import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The API is a separate process in v2 (v1 embedded Vite in the Express server).
const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/health': api,
      '/images': api,
      '/videos': api,
      '/socket.io': { target: api, ws: true },
    },
  },
  build: { sourcemap: true, target: 'es2023' },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.d.ts', 'src/test/**', 'src/main.tsx', 'src/shared/api/schema.d.ts', 'src/**/*.test.{ts,tsx}'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 70, functions: 65, statements: 70, branches: 60 },
    },
  },
});
