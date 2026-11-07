# apps/web

The review app: Vite, React, TanStack Router (code-based routes) and TanStack Query, talking to the server only through Hono's typed client (`src/api.ts`).

- **The token arrives in the URL fragment** (`/#token=…`), which browsers never send to servers. On load, the page moves it to sessionStorage and clears it from the address bar. Never put the token in a query string, a cookie, or logs.
- **`pnpm dev` runs `scripts/dev.ts`.** It starts the API on a free port, then Vite on another free port, and Vite proxies `/api` to the API. The proxy rewrites Origin only for requests coming from Vite's own origin; anything else still gets a 403.
- **The UX bar is high** (see the brief). For new screens, explore the design before building production UI.
