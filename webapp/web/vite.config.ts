import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const webviewSrc = path.resolve(__dirname, '..', '..', 'webview-ui', 'src');
const webviewPublic = path.resolve(__dirname, '..', '..', 'webview-ui', 'public');

const SERVER_URL = process.env.PIXEL_AGENTS_SERVER ?? 'http://127.0.0.1:5179';

export default defineConfig({
  // We share the webview-ui's public/ folder so its asset paths
  // (assets/*, fonts/*) resolve identically.
  publicDir: webviewPublic,
  plugins: [
    tailwindcss(),
    react(),
    // Lightweight middleware: proxy any /assets/* fetch the webview-ui makes
    // to disk. Vite already serves publicDir, so this is mostly a no-op,
    // but we add a fallback for /assets/decoded/* so we don't crash if the
    // pre-decoded JSON endpoints (provided by webview-ui's vite plugin)
    // are missing — the browserMock.ts in webview-ui falls back to
    // decoding PNGs in-browser. Since we DON'T use the browser mock here,
    // this is just defensive.
    {
      name: 'pixel-agents-asset-fallback',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith('/assets/decoded/')) {
            // 404 — the WS bridge supplies these instead.
            req.url = '/assets/__missing__';
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      '/ws': {
        target: SERVER_URL.replace(/^http/, 'ws'),
        ws: true,
      },
      '/api': SERVER_URL,
    },
    fs: {
      // Allow Vite to serve files outside web/ (we import from ../../webview-ui).
      allow: [path.resolve(__dirname, '..', '..')],
    },
  },
  resolve: {
    alias: {
      '@webview': webviewSrc,
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

// Sanity check during dev: warn if the webview-ui source isn't where we expect.
if (!fs.existsSync(webviewSrc)) {
  console.warn(`[webapp/web] expected webview-ui source at ${webviewSrc}`);
}
