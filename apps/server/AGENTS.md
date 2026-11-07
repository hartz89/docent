# apps/server

The local Hono server. It's a thin shell: security, routing and streaming live here, and the logic lives in `@docent/core`.

- **Security is the server's job, and it's tier 2.** Every request passes `ownOriginOnly`, which checks Host (against DNS rebinding) and Origin (against other sites). Every `/api/*` request needs the per-launch bearer token. Don't add a route outside `/api/*` that does anything except serve the built web app.
- **Tests call `app.request()` in-process.** No port, and no mocking of our own code. See `src/app.test.ts` for the style.
- **Hono's `bearerAuth` returns 400, not 401, for a malformed `Authorization` header.** Tests assert the real behavior.
- **Node runs the `.ts` files directly, with no tsx.** Import paths therefore end in `.ts`, and only erasable TypeScript syntax is allowed: no enums, no namespaces, no parameter properties. `tsc -b` emits JS to `dist/` and rewrites the paths.
- `AppType` is exported for the web app's typed client. Change a route's input or output and the web app should fail to typecheck. That's the point.
