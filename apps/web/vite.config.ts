import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The app's entry chunk is what every review waits for, so it gets a hard budget that fails the
 * build. Lazy chunks don't count: Shiki's language grammars (C++ and Emacs Lisp are near 800 kB
 * each) load only when a PR has a file in that language.
 */
const ENTRY_BUDGET_KB = 450;

function entryBudget(): Plugin {
  return {
    name: 'docent:entry-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue;
        const kb = Buffer.byteLength(chunk.code) / 1024;
        if (kb > ENTRY_BUDGET_KB) {
          this.error(
            `${chunk.fileName} is ${kb.toFixed(0)} kB, over the ${ENTRY_BUDGET_KB} kB entry budget. ` +
              'Load the new code lazily with import(), or raise the budget in apps/web/vite.config.ts and say why in the PR.',
          );
        }
      }
    },
  };
}

// Dev wiring (the /api proxy, ports) lives in scripts/dev.ts, which starts
// the API server first and then hands its address to Vite.
export default defineConfig({
  plugins: [react(), entryBudget()],
  // Rolldown's generic warning would fire on every build for the lazy grammars above, and a warning
  // that always fires gets ignored. The entry budget is the check that matters.
  build: { chunkSizeWarningLimit: 1000 },
});
