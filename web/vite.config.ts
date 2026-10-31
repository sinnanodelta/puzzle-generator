import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Writes dist/sw.js from sw.js, with the list of built files and a hash of their content. */
function serviceWorker(): Plugin {
  let root = '';
  let outDir = '';
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(c) {
      root = c.root;
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const files = (readdirSync(outDir, { recursive: true }) as string[])
        .map((f) => f.replace(/\\/g, '/'))
        .filter((f) => f !== 'sw.js' && statSync(join(outDir, f)).isFile())
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const sw = readFileSync(join(root, 'sw.js'), 'utf8')
        .replace("'__VERSION__'", JSON.stringify(hash.digest('hex').slice(0, 16)))
        .replace('__FILES__', JSON.stringify(files));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

// The WASM package is built by wasm-pack into ../crates/puzzle-wasm/pkg (`npm run wasm`) and
// imported by relative path, so the dev server must be allowed to serve the parent folder.
export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    fs: { allow: ['..'] },
    // Files edited from Windows raise no inotify events in WSL (SPEC §9.1).
    watch: { usePolling: true },
  },
  worker: { format: 'es' },
  // three.js alone is most of the bundle; the service worker downloads it once per version.
  build: { chunkSizeWarningLimit: 2000 },
});
