import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    strictPort: true,
    // Vite serves source files in development. Explicitly exclude private JSON and server code.
    fs: { deny: ['.env', '.env.*', '**/*.{crt,pem}', '**/.git/**', '**/.private/**', '**/.pnpm-store/**', '**/server/**', '**/tests/**', '**/docs/**'] },
    proxy: { '/api': 'http://127.0.0.1:8889' },
  },
});
