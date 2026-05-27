import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
        thumbnail: resolve(__dirname, 'thumbnail.html'),
        commentsexporter: resolve(__dirname, 'comments-exporter.html'),
        tagsexporter: resolve(__dirname, 'tags-exporter.html'),
        descriptionexporter: resolve(__dirname, 'description-exporter.html'),
        thumbnailzip: resolve(__dirname, 'thumbnail-zip.html'),
        deletedvideotracker: resolve(__dirname, 'deleted-video-tracker.html'),
        shortsextractor: resolve(__dirname, 'shorts-extractor.html'),
        playlistextractor: resolve(__dirname, 'playlist-extractor.html')
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
    },
  },
})
