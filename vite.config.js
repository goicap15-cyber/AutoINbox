import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.join(__dirname, 'src/client'),
  publicDir: path.join(__dirname, 'public'),
  build: {
    outDir: path.join(__dirname, 'dist/client'),
    emptyOutDir: true
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5050',
        changeOrigin: true,
        cookieDomainRewrite: 'localhost'
      },
      '/socket.io': {
        target: 'http://localhost:5050',
        ws: true,
        changeOrigin: true
      }
    }
  }
});
