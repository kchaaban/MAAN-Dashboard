import { defineConfig } from 'vite';

export default defineConfig({
  base: '/maan-dashboard/',
  server: {
    proxy: {
      '/maan-dashboard/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      }
    }
  }
});
