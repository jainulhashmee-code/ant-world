import { defineConfig } from 'vite';

/**
 * COOP/COEP are required for SharedArrayBuffer, which multi-worker domain
 * decomposition (M4) depends on. The app degrades to a single worker when these
 * headers are absent, so a static host without header control still works.
 */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    target: 'es2022',
    // The renderer and simulation are the payload; keep them readable in dev
    // but do not ship source maps to keep the deploy small.
    sourcemap: false,
  },
  worker: { format: 'es' },
});
