import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/rooms': {
        target: 'http://localhost:8787',
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    target: 'esnext',
    minify: 'terser',
    sourcemap: true
  },
  optimizeDeps: {
    include: ['three']
  }
});