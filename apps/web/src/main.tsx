import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/newsreader';
import './styles.css';
import { ReviewPage } from './review-page.tsx';

// Code-based routes: with one route, a generated route tree and its Vite plugin
// would be more machinery than the routes themselves. Revisit when routes multiply.
// The review page shows the server health page when no review is open.
const rootRoute = createRootRoute();
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: ReviewPage }),
]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing <div id="root">');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
