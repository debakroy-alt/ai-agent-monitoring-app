import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During local dev, run the Functions API with `func start` in /api (port 7071)
// or use the SWA CLI: `swa start http://localhost:5173 --api-location api`.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:7071' } },
});
