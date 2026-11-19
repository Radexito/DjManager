import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'write-dev-url',
      configureServer(server) {
        server.httpServer?.once('listening', () => {
          const { port } = server.httpServer.address();
          writeFileSync(resolve(__dirname, '../.dev-url'), `http://localhost:${port}`);
        });
      },
    },
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
});
