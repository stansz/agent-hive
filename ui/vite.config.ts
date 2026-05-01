import { defineConfig } from 'vite';

export default defineConfig({
  base: '/ui/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/prompt': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/status': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/messages': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/abort': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/events': {
        target: 'ws://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
      '/health': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/system-prompt': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
