import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'No-Show App',
        short_name: 'No-Show',
        description: 'JEDCO No-Show Passenger Reporting – King Abdulaziz International Airport',
        theme_color: '#1a3a5c',
        background_color: '#f0f4f8',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Take over as soon as a new version is deployed. Without this the old
        // service worker keeps serving until every tab of the app is closed,
        // and staff do not close tabs — a fix can sit undelivered for days.
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // Flight data, still cached so a lookup works offline — but the
            // network is asked first.
            //
            // This was CacheFirst, which never asked the server at all while a
            // cached copy existed. Flight data is dated now: the schedule is
            // re-synced every 15 minutes, gates move, and a flight ages out of
            // KAIA's window. A stale reply is not a slightly old reply, it is
            // yesterday's date written into today's report. The same rule also
            // covers /api/flights/kaia/status and /airlines/pending, which
            // were being served up to a week old.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/flights'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'flights-cache',
              networkTimeoutSeconds: 5,   // fall back to cache on a dead network
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 },
            },
          },
          {
            // Network-first for all other API calls
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: { cacheName: 'api-cache' },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
