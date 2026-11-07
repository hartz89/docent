// `pnpm dev`: starts the API server, then Vite with hot reload in front of it.
// Both pick free ports, so several worktrees can run dev at once.
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startServer } from '@docent/server';
import { createServer } from 'vite';

const api = await startServer({});

const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 0,
    proxy: {
      '/api': {
        target: api.origin,
        changeOrigin: true,
        // The API only trusts its own origin. A same-origin request to Vite is
        // one from our own page, so present it to the API as same-origin too.
        // Requests from any other origin pass through untouched and get a 403.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req: IncomingMessage) => {
            if (req.headers.origin === `http://${req.headers.host}`) {
              proxyReq.setHeader('origin', api.origin);
            }
          });
        },
      },
    },
  },
});
await vite.listen();

const url = vite.resolvedUrls?.local[0];
console.log(`Docent dev is running at ${url}#token=${api.token}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all([vite.close(), api.close()]);
    process.exit(0);
  });
}
