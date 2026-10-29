/**
 * Vite dev-server middleware for the same Comfy Cloud proxy the Worker serves.
 * This exists only so the local preview can exercise the real API path; the
 * production endpoint is worker/index.js.
 */
import { Buffer } from 'node:buffer';
import { handleComfyRequest } from './comfy-cloud.js';

export function comfyDevPlugin(env) {
  return {
    name: 'brandproof-comfy-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/comfy/')) {
          next();
          return;
        }

        void (async () => {
          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const headers = new Headers();
            for (const [name, value] of Object.entries(req.headers)) {
              if (Array.isArray(value)) headers.set(name, value.join(', '));
              else if (typeof value === 'string') headers.set(name, value);
            }
            const method = (req.method || 'GET').toUpperCase();
            const request = new Request(`http://localhost${req.url}`, {
              method,
              headers,
              ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
            });
            const response = await handleComfyRequest(request, {
              COMFY_API_KEY: env.COMFY_API_KEY,
            });
            res.statusCode = response.status;
            response.headers.forEach((value, name) => res.setHeader(name, value));
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                error: {
                  code: 'dev_proxy_error',
                  message:
                    error instanceof Error
                      ? error.message
                      : 'The local Comfy Cloud proxy failed.',
                },
              }),
            );
          }
        })();
      });
    },
  };
}
