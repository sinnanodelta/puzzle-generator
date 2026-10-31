import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The WASM package is built by wasm-pack into ../crates/puzzle-wasm/pkg (`npm run wasm`) and
// imported by relative path, so the dev server must be allowed to serve the parent folder.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: ['..'] },
    // Files edited from Windows raise no inotify events in WSL (SPEC §9.1).
    watch: { usePolling: true },
  },
  worker: { format: 'es' },
  // three.js alone is most of the bundle, and the app is served locally.
  build: { chunkSizeWarningLimit: 2000 },
});
