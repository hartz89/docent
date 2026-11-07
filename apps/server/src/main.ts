// Production entry point: serves the built web app and the API from one origin.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.ts';

// Resolves from both src/ and dist/, which sit at the same depth.
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));

if (!existsSync(webRoot)) {
  console.error(`Web app not built (missing ${webRoot}). Run: pnpm build`);
  process.exit(1);
}

const server = await startServer({ webRoot });

// The token rides in the URL fragment, which browsers never send to servers.
console.log(`Docent is running at ${server.origin}/#token=${server.token}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
