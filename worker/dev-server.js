/**
 * Vite dev-server middleware for the same Comfy Cloud proxy and catalog ledger
 * the Worker serves. This exists only so the local preview can exercise the
 * real API paths; the production entrypoint is worker/index.js.
 */
import { Buffer } from 'node:buffer';
import { handleComfyRequest } from './comfy-cloud.js';
import { handleCatalogRequest } from './catalog.js';

export function comfyDevPlugin(env) {
  return {
    name: 'brandproof-comfy-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        const isComfy = url.startsWith('/api/comfy/');
        const isCatalog = url.startsWith('/api/catalog/');
        if (!isComfy && !isCatalog) {
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
            const request = new Request(`http://localhost${url}`, {
              method,
              headers,
              ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
            });
            const response = isCatalog
              ? await handleCatalogRequest(request, {
                  CATALOG_DB: env.CATALOG_DB,
                  CATALOG_ESTIMATE_CREDITS_PER_ATTEMPT: env.CATALOG_ESTIMATE_CREDITS_PER_ATTEMPT,
                  CATALOG_DAILY_CREDIT_CAP: env.CATALOG_DAILY_CREDIT_CAP,
                })
              : await handleComfyRequest(request, {
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
                      : 'The local BrandProof API proxy failed.',
                },
              }),
            );
          }
        })();
      });
    },
  };
}
