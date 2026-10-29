/**
 * BrandProof is a fully client-side app. The Worker only serves the Vite build
 * and the single-page entry point; no server code, database or secret is used.
 */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
