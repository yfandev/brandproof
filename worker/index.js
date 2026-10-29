import { handleComfyRequest } from './comfy-cloud.js';
import { handleCatalogRequest } from './catalog.js';

/**
 * BrandProof serves the static Vite build, a small same-origin Comfy Cloud API
 * proxy, and the catalog pilot ledger. The API key and catalog database live
 * only in Worker environment bindings.
 */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/comfy' || pathname.startsWith('/api/comfy/')) {
      return handleComfyRequest(request, env);
    }
    if (pathname === '/api/catalog' || pathname.startsWith('/api/catalog/')) {
      return handleCatalogRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
