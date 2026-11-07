import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev wiring (the /api proxy, ports) lives in scripts/dev.ts, which starts
// the API server first and then hands its address to Vite.
export default defineConfig({
  plugins: [react()],
});
