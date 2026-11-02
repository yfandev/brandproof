# BrandProof — project context

This file is the handoff for anyone picking this repository up in a new session. Read it before changing code, then
`README.md` for the product story and the workflow details.

## What this repository is

BrandProof is an open-source build on the Comfy developer platform: a static React frontend plus one same-origin Worker
that holds the Comfy Cloud key, generates LTX-2.3 clips, and verifies the returned video in the browser. It won the
**Comfy Build Nights** hackathon in San Francisco on **28 October 2026** with the v1 Studio build; the Catalog Pilot Run
(v2) was added afterwards and was not part of that event.

Two tabs ship in this one app: **Catalog pilot** (up to two products, a corrective loop of up to two attempts each, a
server-side budget ledger) and **Studio** (the single-product build that was demoed on stage). Catalog pilot is the
landing tab and Studio carries the award banner.

- Remote: `github.com/yfandev/brandproof`, working branch `feature/catalog-pilot-parallel`.
- Stack: React 19, Vite 8, TypeScript 5.9, Tesseract.js 7 (named "on-device OCR" in user-visible copy only).
- Commands: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`.

## The other deliverable, which is not this one

**BrandProof Verify** is a separate paid product in a separate repository (`github.com/yfandev/brandproof-verify`,
branch `main`) deployed to a separate site with its own license gate and its own Lemon Squeezy storefront. It has no
generation and no Comfy Cloud call. Its context lives in that repository's `PROJECT.md`.

Keep the two fully apart: no verifier copy, screenshots or pricing here, and nothing from this open-source app in the
paid one. The verifier directory may exist inside this checkout on a developer machine as an excluded nested
repository; it belongs to its own remote and this repository must never track it.

## Site deployments

| Environment | URL | Notes |
| --- | --- | --- |
| BrandProof Catalog Pilot, production | <https://site-1c9233282e504a2a97f7a99451660186.freebuff.page> | Current build, project id `1edf215f-c2d4-465b-b50e-aed8d96c6ffc`. Bindings: `CATALOG_DB` (D1 `41b9ea24-08e7-4ae3-962d-d7c1912d68a9`) and the `COMFY_API_KEY` secret. |
| BrandProof Catalog Pilot, preview | <https://site-f6bf20b690ba408e8078305a9210b7a8.freebuff.page> | Test builds only. |
| BrandProof (older project), production | <https://site-ebd71277-f0a7-4c42-9a1e-03ac68e5b0e2.freebuff.page> | Project id `2f5d7c9a-4b8e-4c1a-9f3d-6e2a1b0c8d7e`. Still serves the 29 October build; a stale duplicate of this same app. Decide whether to keep it published. |

The deploy manifest is `deploy.json` at the repository root: worker entry `worker/index.js` with `worker/comfy-cloud.js`
and `worker/catalog.js` as extra modules, assets from `./dist`, SPA fallback, compatibility date 2026-10-28. `dist` is
git-ignored, so build before deploying, and deploy by passing this manifest explicitly.

## The deployment hazard worth remembering

The workspace Publish button builds the checkout root and ships it to whichever site the current chat is associated
with. That is safe only when the checkout root is this repository and the selected site is a BrandProof project. On
1 November 2026 the same button, pressed from a checkout whose root was this repository but whose site was BrandProof
Verify, replaced the paid verifier's production build for three minutes before it was restored. Deploy this app from a
session rooted here and aimed at a BrandProof site, and never leave the verifier nested inside this checkout without
the exclusion that keeps it out of this repository.
