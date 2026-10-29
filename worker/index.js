import { handleComfyRequest } from './comfy-cloud.js';

/**
 * BrandProof serves the static Vite build and a small same-origin Comfy Cloud
 * API proxy. The API key lives only in Worker environment bindings.
 */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/comfy' || pathname.startsWith('/api/comfy/')) {
      return handleComfyRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
