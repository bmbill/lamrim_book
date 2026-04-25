import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Project Pages：將環境變數 VITE_BASE 設為 /倉庫名稱/（例如 /lamrim_book/）
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  /** 允許同網段手機直連 dev server（以 IP 存取）。僅綁到 0.0.0.0；防火牆設定仍由使用者控制。 */
  server: { host: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      /** 開發時不要註冊 SW，避免舊快取規則攔截 /data/*.gz 導致 Failed to fetch */
      devOptions: { enabled: false },
      includeAssets: ['pdfs/.gitkeep'],
      manifest: {
        name: '廣論與南山律 PDF 閱讀',
        short_name: 'PDF閱讀',
        description: '菩提道次第廣論、南山律相關 PDF 閱讀',
        theme_color: '#1e293b',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: `${base === '/' ? './' : base}`,
        scope: base === '/' ? './' : base,
        lang: 'zh-Hant',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'document',
            handler: 'NetworkFirst',
            options: { cacheName: 'html-cache' },
          },
          {
            // 索引檔大（~2.5–7MB）、每次 reload 都用：先回快取再背景更新，
            // 第二次以後幾乎是即時開啟；新版本 build 後下一次 reload 自動換新
            urlPattern: ({ url }) => /\/data\/[a-z-]+\.json\.gz$/.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'lamrim-transcripts',
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.pdf'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdf-cache',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
});
