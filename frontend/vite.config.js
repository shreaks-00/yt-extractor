import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html')
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/extract': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
    },
  },
})
