# BrandProof

**Visual fidelity verification for AI-generated product ads.**

Upload a product pack shot, generate or import an AI advertising clip, then verify that the brand name and printed label survive the render. BrandProof samples frames in your browser, reads the label with Tesseract.js, overlays the actual OCR word boxes, compares the palette against the reference photo, and produces a PASS / REVIEW / FAIL report you can download as JSON.

Built for the **Comfy Open Source × Higgsfield** hackathon. No paid API, no server, no database, no hidden keys.

![status](https://img.shields.io/badge/status-MVP-d7ff5f) ![license](https://img.shields.io/badge/license-MIT-white) ![stack](https://img.shields.io/badge/stack-React%20%2B%20Vite%20%2B%20Tesseract.js-white)

---

## Why this exists

AI video models will happily redraw a label, misspell a brand, or invent a second ingredient list. Brand teams need evidence, not vibes. BrandProof turns the finished clip into frame-level OCR evidence:

- every expected token is matched against every sampled frame;
- unreadable frames are reported as unreadable, never silently counted as mismatches;
- a verdict requires _sufficient evidence_, so weak OCR produces REVIEW instead of a confident lie;
- the JSON report contains the configuration, checks, per-frame words, boxes and limitations.

It is an automated consistency check, **not** proof that the product is pixel-identical in every frame.

---

## Quick start

Requirements: **Node.js ≥ 20.19** and a modern Chromium/Firefox/Safari browser. A GPU is only needed if you want to generate clips locally.

```bash
npm install
npm run dev
# open the printed URL (default http://localhost:3000)
```

Other scripts:

```bash
npm run typecheck   # strict TypeScript, no emit
npm test            # Vitest unit tests (normalization, verdict rules, ComfyUI client)
npm run build       # typecheck + production build to dist/
npm run preview     # serve the production build
```

No environment variables are required. BrandProof never stores an API key.

---

## The product workflow

1. **Product reference** — drop a pack shot (PNG/JPEG/WebP/AVIF, ≤ 25 MB). It is decoded locally. Optional: drag a **label area** rectangle, or let OCR read the photo to prefill the expected text.
2. **Brand contract** — enter the exact brand name (required) and the printed label text, one line per printed line. Pick **Luxury Studio**, **Sunset Outdoors** or **Neon City**, then edit the generated prompt if you like.
3. **Clip** — use **Generate video** against your own free ComfyUI server, or **Import existing video** (MP4/H.264 or WebM).
4. **Verify product fidelity** — choose strictness, coverage and sample count, then run.
5. **Evidence report** — verdict, critical checks, token matrix, filmstrip, OCR boxes, manual region re-run, and **Download JSON report**.

Everything after the clip exists is local.

---

## How verification actually works

### 1. Frame sampling

`sampleTimes()` picks evenly spaced timestamps from 4% to 96% of the clip duration (6, 9 or 12 frames). Each frame is seeked, drawn to its own canvas (max width 1280), and stored as a JPEG thumbnail. Frame canvases are what OCR reads; the JPEGs are only for display.

If the browser cannot decode or seek the clip, verification stops with a concrete error instead of producing an empty report. MOV/HEVC clips usually fail here — re-encode to MP4/H.264 or WebM.

### 2. OCR

Tesseract.js 7 runs in a web worker with English (`eng`) model data. Each frame is read with **sparse text** page segmentation, or **single block** when a manual label region is set. For crops narrower than ~720 px the crop is upscaled before recognition. Word bounding boxes are converted back into normalized 0–1 coordinates of the **full frame**, so overlays align even when OCR only saw a crop.

Large or dense frames are not tiled — that is a documented limitation.

### 3. Normalization and matching

Expected text is normalized with `normalizeText()`:

- Unicode NFKD, diacritics removed (`Lumière` → `lumiere`);
- typographic quotes/dashes unified, everything else non-alphanumeric becomes a space;
- lowercased, whitespace collapsed.

The brand name's tokens and the label text's tokens (minus tokens already in the brand) are compared against OCR candidates. Candidates include raw words, alphanumeric splits (`30ML` → `30`, `ml`) and joins of up to three adjacent words on the same visual line (`AURELIA` + `SERUM` → `aureliaserum`). Similarity is normalized Levenshtein distance; containment scores just below an exact hit.

Match thresholds by strictness:

| Strictness | Token similarity | Minimum OCR word confidence |
| ---------- | ---------------- | --------------------------- |
| Strict     | 95%              | 60                          |
| Balanced   | 87%              | 45                          |
| Lenient    | 75%              | 30                          |

A token is `match` at/above threshold, `near` at ≥ 72% of threshold (minimum 50%), otherwise `missing`. A frame is only "legible" with at least one confident word, ≥ 4 characters and mean confidence ≥ 35; otherwise its tokens become `unreadable`.

### 4. Verdict rules

Let **readable** = frames with legible OCR text. `coverage` is user-set (default 60%). Required evidence is `max(2, ceil(0.4 × sampled))` readable frames and a passing legibility check (≥ 70% readable, mean confidence ≥ 55).

**PASS** requires all of:

- brand matched in ≥ coverage of readable frames;
- every configured label token matched in ≥ coverage of readable frames (skipped if no label text);
- readable frames ≥ required;
- legibility check passes;
- no critical check fails.

**FAIL** requires a demonstrable critical failure:

- readable text in ≥ 2 frames with confidence ≥ 50 but the brand never appears; or
- the brand appears altered (near matches) in ≥ 50% of readable frames and is matched in < 50%; or
- the brand is read correctly in ≥ 2 frames but none of the configured label tokens ever appear (only when "Treat missing label text as critical" is on).

**REVIEW** is everything else: insufficient readable frames, partial coverage, low OCR confidence, near matches without a majority, or label text only partially found.

Palette overlap is **advisory**: it can turn a PASS into REVIEW evidence but never forces FAIL, because a new scene legitimately changes the colour distribution.

### 5. Manual label region

If OCR fails, draw a rectangle on the product photo or on any evidence frame and re-run. The same normalized rectangle is cropped from every frame for both OCR and palette comparison. This assumes the label stays roughly in that screen position — appropriate for locked-off product shots, not for fast handheld moves. The UI says so.

### 6. Report

The JSON report (`brandproof-<brand>-<timestamp>.json`) contains:

- `verdict`, `headline`, `summary`, `schemaVersion: "brandproof.report/1"`;
- full config: text, scene, strictness, computed threshold, coverage, sample count, region;
- checks with status, criticality, metric and explanation;
- metrics: readable frames, brand/label recall, mean confidence, palette similarity;
- token evidence with per-token hit/near/missing/unreadable counts;
- every frame: time, dimensions, legible flag, status, recognized text, all words with normalized boxes and confidence;
- limitations.

Frame images are deliberately **not** embedded in the JSON; they stay in the browser.

---

## Video generation with ComfyUI (free, self-hosted)

BrandProof integrates with the real ComfyUI HTTP API (`/system_stats`, `/upload/image`, `/prompt`, `/history`, `/queue`, `/view`). It targets a ComfyUI instance **you** run, so no paid API subscription or API key is involved. Comfy Cloud requires paid credits, so it is supported through the import path instead.

### Requirements

- ComfyUI with native Wan 2.2 nodes (`Wan22ImageToVideoLatent`, `Wan22 VAE`, `SaveVideo`, `CreateVideo`). Update ComfyUI if these nodes are missing.
- Models from [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged):

```
ComfyUI/
└── models/
    ├── diffusion_models/
    │   └── wan2.2_ti2v_5B_fp16.safetensors      (9.31 GB)
    ├── text_encoders/
    │   └── umt5_xxl_fp8_e4m3fn_scaled.safetensors (6.27 GB)
    └── vae/
        └── wan2.2_vae.safetensors                (1.31 GB)
```

The 5B model runs on roughly 8 GB VRAM with ComfyUI offloading. Generation time depends heavily on GPU; expect minutes, not seconds.

### Start ComfyUI with CORS enabled

```bash
python main.py --enable-cors-header
```

The app defaults to `http://127.0.0.1:8188`; edit the endpoint in the Generate tab and press **Test connection**. `--listen 0.0.0.0` is only needed for a ComfyUI server on another machine, and it exposes the server to your network — secure it appropriately.

If BrandProof is served over HTTPS, browsers block plain `http://` ComfyUI requests as mixed content. Use a local build/dev server over HTTP, or put ComfyUI behind an HTTPS reverse proxy.

### The bundled workflow

[`comfy/workflows/wan22_ti2v_api.json`](comfy/workflows/wan22_ti2v_api.json) is an **API-format** workflow derived from the official ComfyUI Wan 2.2 5B TI2V template. It is editable in the app and downloadable there.

BrandProof injects values into it on every run:

| Value            | Target                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| prompt           | every `CLIPTextEncode` node without "neg" in its title                  |
| negative prompt  | `CLIPTextEncode` nodes titled with "neg"                                |
| product photo    | every `LoadImage` node (uploaded via `/upload/image`)                    |
| width / height   | `Wan22ImageToVideoLatent` (832×480 landscape, 480×832 portrait, 640×640 square) |
| frame count      | `Wan22ImageToVideoLatent.length` (81 frames)                             |
| seed             | sampler `seed` / `noise_seed` inputs                                    |
| output prefix    | `SaveVideo` `filename_prefix` (`brandproof/clip-<timestamp>`)            |

If you paste your own workflow, it must be **API format** (`Workflow → Export (API)` in ComfyUI) and must contain a `LoadImage` node, otherwise BrandProof refuses to generate rather than produce an ad that ignores your product. GIF/WebP outputs are rejected: verification needs a real video file.

`SaveVideo` is set to `mp4` + `h264`. MP4 plays in every target browser.

### Generation status

BrandProof polls ComfyUI's real queue and history. The UI shows the accepted prompt id, queue position, generation state and elapsed time. It never fakes a progress percentage or a successful result. Errors from ComfyUI — missing models, node validation errors, CUDA OOM, animated-image output — are surfaced verbatim in the log.

### No GPU? Use Comfy Cloud + import

1. Open the Wan 2.2 5B workflow in [Comfy Cloud](https://www.comfy.org/cloud) (paid subscription).
2. Upload the product photo to the Load Image node.
3. Paste the prompt from step 02 of BrandProof; keep the label text instruction intact.
4. Run, download the MP4, and use **Import existing video**.

The import path is fully functional and is the recommended fallback for anyone without a local GPU.

---

## Testing the full workflow

### Fast test with a real clip

1. `npm install && npm run dev`, open the app.
2. Upload a product photo where the label is readable (a real product shot or a screenshot of packaging).
3. Type the brand name exactly, then the label lines. Optionally press **Scan photo** and click `+ label` on recognized lines.
4. Pick a scene, keep or edit the prompt.
5. Import a short clip (2–6 s) that shows the product. If you have no clip, generate one with your ComfyUI, or make a deterministic fixture from the pack shot:

   ```bash
   ffmpeg -loop 1 -i packshot.png \
     -vf "scale=1440:-2,zoompan=z='1+0.0006*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=120:s=1280x720:fps=30,format=yuv420p" \
     -t 4 -c:v libx264 -pix_fmt yuv420p -movflags +faststart test-ad.mp4
   ```

   That is a synthetic fixture for testing the verifier, not a generated ad. Any real clip with a label works.
6. Press **Verify product fidelity**. Watch the four progress stages; OCR runs frame by frame.
7. Inspect the verdict, checks, frame filmstrip, overlays and token matrix. Click thumbnails; draw a label region on a frame and choose **Re-run with this area**.
8. Press **Download JSON report** and inspect it in any editor.

### Deliberately test REVIEW and FAIL

- Rename the brand in the form (e.g. change one letter) and re-run: near-match evidence should produce REVIEW or FAIL depending on how OCR reads it.
- Add a label line that is definitely not printed, keep "Treat missing label text as critical" on, and re-run: expect FAIL on the label check.
- Import a clip with no visible text: expect REVIEW with a failing legibility check, not a fake PASS.
- Lower the sample count to 6 and raise coverage to 90% to see coverage-driven REVIEW.

### Automated checks

```bash
npm test        # 34 unit tests: normalization, matching, verdict rules, report export, ComfyUI client
npm run build   # typecheck + production build
```

The ComfyUI HTTP client is unit-tested with mocked responses (success, execution error, animated image, unreachable server, workflow binding). End-to-end generation requires a real ComfyUI server and GPU, so it cannot be exercised in CI or in this sandbox.

### Known runtime dependency

Tesseract.js downloads its WASM engine and the `eng` traineddata from the jsDelivr CDN on first OCR use (then caches in IndexedDB). If that CDN is blocked, OCR fails with an explicit message. To self-host, copy the Tesseract worker/core/`eng.traineddata.gz` assets into `public/` and set `workerPath` / `corePath` / `langPath` in `src/lib/ocr.ts` — see the [Tesseract.js local installation guide](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md).

---

## Limitations

- **OCR is not a forensic check.** Tiny, curved, embossed, engraved, reflective or motion-blurred text can stay unreadable even for a human; BrandProof reports that as low legibility.
- **Sampling is discrete.** Incorrect text that appears only between sampled frames can be missed. Raise sample count for fast cuts.
- **Text only, plus a colour heuristic.** There is no logo-shape matching, structural comparison or audio analysis. Palette overlap is a coarse 4×4×4 RGB histogram intersection, not identity.
- **One product per run.** Multiple labels, multi-language packs and full-frame reading can produce noisy OCR; use the label region.
- **Region OCR assumes stable framing.** A moving label invalidates the fixed rectangle.
- **No server trust layer.** Reports are browser-generated and unsigned; anyone can edit a downloaded JSON.
- **Browser codec support.** MP4/H.264 and WebM are supported; MOV/HEVC usually is not. Frame seeking can fail on exotic codecs.
- **Generation requires your own ComfyUI.** No hosted free video API is called. Models, VRAM and queue time are yours to manage. The bundled workflow is a starting point; different custom nodes may need a different workflow.
- **CORS and mixed content** can block a local ComfyUI endpoint. Start ComfyUI with `--enable-cors-header`; serve the app over HTTP or proxy ComfyUI over HTTPS.

---

## Publish the live app for free

BrandProof is a static single-page app plus a tiny static-asset Worker. There is nothing to configure, no database, no secrets.

### Option A — Freebuff Sites (recommended, free)

1. Run the production build:

   ```bash
   npm run build
   ```

2. In the Sites panel, create a project (e.g. `brandproof`).
3. Deploy the prebuilt manifest [`deploy.json`](deploy.json). It serves `dist/` through `worker/index.js`, which simply returns `env.ASSETS.fetch(request)` with SPA fallback.
4. Open the preview URL, run the workflow once, then publish when you are happy.

No environment variables, D1 databases, R2 buckets or auth bindings are required. If you redeploy after changing code, rebuild first so `dist/` is current.

### Option B — Cloudflare Pages (free)

- Framework preset: none / Vite
- Build command: `npm run build`
- Output directory: `dist`
- Environment variables: none

### Option C — Netlify / Vercel / GitHub Pages

Publish `dist/` as a static site. If hosting under a subpath (GitHub Pages), set Vite's `base` in `vite.config.ts` to that path before building.

### After deploying

- OCR still loads its engine/model from jsDelivr, so the visitor needs access to that CDN.
- A deployed HTTPS page cannot call a local `http://` ComfyUI due to mixed content. Import works everywhere; direct generation is best on a local/HTTP build or behind an HTTPS proxy.
- Test one import + verify + JSON download on the deployed URL, and — if you expose one — one generation against your ComfyUI server.

---

## Publish to GitHub

```bash
git init
git add .
git commit -m "BrandProof: product and label fidelity verification for AI video"
git branch -M main
git remote add origin https://github.com/<your-user>/brandproof.git
git push -u origin main
```

The repository is ready to publish: [MIT license](LICENSE), no secrets, no committed build output (`dist/` is ignored), no generated assets. Add a screenshot or GIF of a real verification run to the README if you want extra polish.

---

## Project structure

```
comfy/workflows/wan22_ti2v_api.json  documented API-format Wan 2.2 workflow
deploy.json                          static Sites manifest
worker/index.js                      ASSETS.fetch static worker
src/
  App.tsx                            workflow state and page composition
  components/
    ProductPanel.tsx                 upload, palette, label-region, reference OCR
    BriefPanel.tsx                   brand text, scene presets, editable prompt
    VideoPanel.tsx                   import tabs, player, Comfy Cloud guide
    ComfyPanel.tsx                   endpoint test, workflow editor, generation log
    VerifyPanel.tsx                  strictness/coverage controls and progress
    EvidenceReport.tsx               verdict, checks, filmstrip, boxes, token matrix
    RegionPicker.tsx                 normalized drag-rectangle selector
  lib/
    analyze.ts                       sampling → OCR → palette → report pipeline
    frames.ts                        seek/canvas frame capture
    ocr.ts                           Tesseract.js worker, crop mapping
    text.ts                          normalization, candidate building, similarity
    verdict.ts                       frame evaluation, rules, report assembly
    comfy.ts                         ComfyUI API client + workflow binding
    image.ts                         reference decode, palettes, crops
    video.ts                         file validation and metadata probing
    report.ts                        JSON export/download
  styles.css                        dark studio design system
```

**Privacy:** the photo, clip, frames and report exist only in the browser tab. The only network calls are to jsDelivr (OCR assets) and to the ComfyUI endpoint you enter.

**License:** [MIT](LICENSE). Tesseract.js is Apache-2.0; ComfyUI and the Wan 2.2 models carry their own licenses.
