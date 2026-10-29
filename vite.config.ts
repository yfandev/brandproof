import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { comfyDevPlugin } from './worker/dev-server.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [react(), comfyDevPlugin(env)],
    server: {
      host: '0.0.0.0',
      port: 3000,
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'worker/**/*.test.js'],
    },
  };
});
