# BrandProof

**Label-fidelity verification for AI-generated product ads — and a loop that regenerates until the label is proven.**

Upload a product pack shot, generate or import an AI advertising clip, then verify that the brand name and printed label survive the render. BrandProof samples frames in your browser, reads the label with Tesseract.js, overlays the actual OCR word boxes, compares the palette against the reference photo, and produces a PASS / REVIEW / FAIL report you can download as JSON.

**v2 closes the loop.** The Catalog Pilot Run verifies up to 8 products in parallel and does not stop at the first verdict: when a clip comes back FAIL or REVIEW, BrandProof rewrites the prompt from that attempt's own evidence, generates a new clip and re-verifies — repeated until the label is genuinely proven, or until three attempts are spent. No product is approved without a real PASS.

Built for the **Comfy Open Source × Higgsfield** hackathon. BrandProof is a static React frontend plus a small same-origin Worker API proxy; the Comfy key stays in the Worker. Comfy Cloud runs the actual LTX-2.3 image-to-video workflow, and the returned MP4 is verified locally in the browser.

![status](https://img.shields.io/badge/status-MVP-d7ff5f) ![license](https://img.shields.io/badge/license-MIT-white) ![stack](https://img.shields.io/badge/stack-React%20%2B%20Vite%20%2B%20Tesseract.js-white)

---

## 👋 Coming back to BrandProof? Start here

**The version you saw at Comfy Build Nights was v1 — Studio, and it won.** On **28 October 2026** in San Francisco that build placed in the **top three** of the Comfy Build Nights event (its award list is unranked among the top three). The online [Comfy Open Source × Higgsfield competition](https://comfy.org/open-source-higgsfield) is a separate entry with its own submission form, not a later round of the Build Nights, and no result in it is claimed here. One product photo in, one Comfy-generated ad out, one OCR fidelity report.

**This version goes further: v2 adds the Catalog Pilot Run — and it is not just a batch.** Instead of one product at a time, you enter up to 8 products, and every product runs a **corrective loop that iterates on the generated video until the label is proven**, rather than a single shot you inspect yourself:

- it generates a real LTX-2.3 clip for every product **concurrently** on Comfy Cloud, up to a configurable limit, so one slow product never holds up the others;
- it verifies each returned MP4 with the same Tesseract.js OCR pipeline and the same PASS / REVIEW / FAIL rules — nothing is loosened for the catalog;
- **PASS is a gate, not a report.** If the clip comes back **FAIL or REVIEW**, BrandProof reads that attempt's own OCR evidence, rewrites the prompt to target what the evidence actually showed, and generates a **new clip** for that product — repeating until a genuine PASS lands, or until **3 total attempts** are used up and the product is handed to a human. REVIEW never counts as approved, and no threshold is relaxed to force a pass;
- a live board tracks every product's attempts, verdict, frame evidence and spend, with run metrics, batch JSON and CSV export, and a **server-side budget ledger** that refuses a new generation when the run budget or the daily cap cannot cover it.

**So the difference is the loop, not the batch size.** v1 gives you one clip and a verdict; v2 keeps generating and re-verifying until the returned video actually proves the label, and stops honestly when it cannot. **Nothing was removed or redefined** — v1 Studio is still the first thing you see in the app, the workflow and verdict rules below still describe it exactly, and the catalog calls the same generation and verification code. The Catalog Pilot Run is served by its own deployment so the awarded build stays exactly as it was demoed.

### v1 → v2 at a glance

|  | **v1 — Studio** (the awarded build) | **v2 — Catalog Pilot Run** (added here) |
| --- | --- | --- |
| Scope | One product, one verification | Up to 8 products in one run |
| Generation | **Generate with Comfy Cloud** for the uploaded photo | Same LTX-2.3 workflow, one real job per product, **in parallel** |
| Verification | Tesseract.js OCR → PASS / REVIEW / FAIL | Same pipeline and the same verdict rules, per product |
| **What produces a pass** | You generate a clip and judge the verdict; re-running is manual | A **closed loop**: generate → OCR-verify → rewrite the prompt from that attempt's evidence → regenerate, until a genuine PASS or 3 attempts |
| **When it stops** | Whenever you stop | Only on PASS, on the 3rd attempt, on budget exhaustion or on an error — REVIEW never approves |
| Results | One evidence report + JSON | Live results board, per-attempt history, metrics, batch JSON and CSV export |
| Spend controls | None | Server-side budget ledger in D1: per-run budget, concurrency limit, daily cap |
| Live URL | [site-ebd712779b3a4bf1879d40dc062c2b30](https://site-ebd712779b3a4bf1879d40dc062c2b30.freebuff.page) | [site-f6bf20b690ba408e8078305a9210b7a8](https://site-f6bf20b690ba408e8078305a9210b7a8.freebuff.page) |

Jump to: [v1 workflow](#the-product-workflow) · [how verification works](#how-verification-actually-works) · [v2 Catalog Pilot Run](#catalog-pilot-run-new-in-v2)

---

## ▶ Live demos

### v1 — Studio (the awarded build)

# https://site-ebd712779b3a4bf1879d40dc062c2b30.freebuff.page

That is the **Production** deployment of the build that was demoed at Comfy Build Nights, unchanged. The Comfy Cloud API key is bound as a server-side secret on that environment, so **Generate with Comfy Cloud** works for any visitor — no install, no local ComfyUI, no key and no account needed to try the app.

```text
GET https://site-ebd712779b3a4bf1879d40dc062c2b30.freebuff.page/api/comfy/status
→ {"configured":true,"provider":"Comfy Cloud","api":"v2","workflowRequired":true}
```

A Preview deployment of the same build is also available at <https://site-0c21528a747244fda433b4bd55129eee.freebuff.page>.

### v2 — Catalog Pilot Run (new)

# https://site-f6bf20b690ba408e8078305a9210b7a8.freebuff.page

Its **own deployment**, with its own Worker, its own D1 budget ledger and its own copy of the Comfy secret — kept separate so the awarded build above is never affected by it. Open it, choose **Catalog pilot**, add products and start a run; the Studio workflow is still in the same app. Details: [Catalog Pilot Run](#catalog-pilot-run-new-in-v2).

---

## 🏆 Top 3 — Comfy Build Nights, San Francisco, 28 October 2026

> **This award belongs to v1 — Studio**, the single-product build documented in most of this file. The Catalog Pilot Run was added afterwards and was not part of that event.
>
> BrandProof placed in the **top three at the Comfy Build Nights** event held in San Francisco on **28 October 2026**. That event's award list is unranked among the top three, so no further placement is claimed.
>
> This is the **Build Night result only**. The online [Comfy Open Source × Higgsfield competition](https://comfy.org/open-source-higgsfield) is separate from the Build Nights — Comfy's own FAQ puts the online competition and the Build Nights on separate tracks — and this repository makes no claim about it.

---

## Why this exists

AI video models will happily redraw a label, misspell a brand, or invent a second ingredient list. Brand teams need evidence, not vibes. BrandProof turns the finished clip into frame-level OCR evidence:

- every expected token is matched against every sampled frame;
- each frame gets a full-frame pass plus a label-crop pass with grayscale, contrast and adaptive-threshold variants;
- unreadable frames and undetected lines are reported honestly, never silently counted as mismatches;
- a verdict requires _sufficient evidence_, so weak OCR produces REVIEW instead of a confident lie;
- the JSON report contains the configuration, checks, per-frame words, boxes and limitations.

It is an automated consistency check, **not** proof that the product is pixel-identical in every frame.

---

## Quick start

### Prerequisites

- **Node.js ≥ 20.19** (`package.json` → `engines`); Node 22 LTS is a safe choice.
- **npm**, matching the committed `package-lock.json`. Install with `npm install` / `npm ci`; no other package manager is configured.
- A modern Chromium, Firefox or Safari browser with Canvas and `HTMLVideoElement` support (OCR runs in a web worker).
- A **Comfy Cloud account with API access and a key** for direct generation — see [Required Comfy Cloud setup](#required-comfy-cloud-setup). The key is server-side only.
- Network access to the jsDelivr CDN on first OCR use (Tesseract.js engine + `eng` model).
- A GPU is only needed for the optional advanced local ComfyUI path; it is **not** required for Comfy Cloud generation.

```bash
npm install
cp .env.example .env.local   # set COMFY_API_KEY for local API testing
npm run dev
# open the printed URL (default http://localhost:3000)
```

Other scripts:

```bash
npm run typecheck   # strict TypeScript, no emit
npm test            # Vitest unit tests, including the Comfy Cloud proxy contract
npm run build       # typecheck + production build to dist/
npm run preview     # serve the production build
```

The browser never receives `COMFY_API_KEY`. Locally, Vite's server middleware reads it from `.env.local`; in production the Worker reads the hosting secret. The UI shows an explicit setup card when it is missing.

---

## Architecture

BrandProof is a React 19 + TypeScript single-page app built by Vite 8, plus one small server-side piece: a Worker that serves the built assets and proxies the Comfy Cloud API. There is no database, queue, auth service or background job.

| Piece | Technology | File |
| --- | --- | --- |
| UI | React 19, TypeScript (strict) | `src/App.tsx`, `src/components/` |
| Build | Vite 8 (`dist/`) | `vite.config.ts` |
| Server proxy | Cloudflare-Worker-compatible ES module | `worker/index.js`, `worker/comfy-cloud.js` |
| Dev proxy | The same handler inside Vite middleware | `worker/dev-server.js` |
| OCR | Tesseract.js 7 (`eng`) | `src/lib/ocr.ts` |
| Tests | Vitest 5 | `src/lib/__tests__/`, `worker/comfy-cloud.test.js` |

Data flow:

1. **Browser UI** collects the product image, the expected brand and label text, the scene and the editable prompt.
2. **Worker proxy** receives a same-origin `POST /api/comfy/generate`, uploads the photo to Comfy Cloud assets, binds the bundled LTX-2.3 graph and submits the job. Only the Worker holds `COMFY_API_KEY`.
3. **Comfy Cloud** runs the LTX-2.3 image-to-video workflow; the browser polls `GET /api/comfy/jobs/{id}` and fetches the finished MP4 from `GET /api/comfy/jobs/{id}/video`.
4. **Browser verification** samples frames from that MP4 with an `HTMLVideoElement` and the Canvas API, then runs Tesseract.js 7 OCR on each frame.
5. **Comparison and report** match the recognized words against the expected tokens and assemble the verdict, evidence and downloadable JSON.

The proxy routes are `/api/comfy/status`, `/api/comfy/generate`, `/api/comfy/jobs/{id}` and `/api/comfy/jobs/{id}/video`. Nothing else is proxied, and the key is never returned by any of them.

---

## Environment variables and secrets

The app reads exactly one environment variable. `COMFY_API_KEY` (and the Worker's built-in `ASSETS` binding) are the only names referenced in the source.

| Variable | Required | Scope | Purpose |
| --- | --- | --- | --- |
| `COMFY_API_KEY` | Required for **generation**; optional for import + verification | **Server-side only** — Worker binding `env.COMFY_API_KEY`, or `.env.local` for the Vite dev proxy | Bearer token for `https://cloud.comfy.org/api/v2/*` |

Rules that keep the key safe:

- **Never** rename it to `VITE_COMFY_API_KEY`. Vite inlines `VITE_*` values into browser JavaScript, which would publish the key to every visitor.
- `.env.local` is git-ignored. `.env.example` contains the name with an empty value and nothing else.
- In production the key is a hosting secret, not a file: add `COMFY_API_KEY` under **Settings → Secrets**, then redeploy so the Worker receives the binding. `.secrets/` and `.dev-server.pid` are git-ignored as well.
- The browser only ever calls same-origin `/api/comfy/*`. `GET /api/comfy/status` answers `{ "configured": true | false, ... }` and never echoes the key.

Minimal local configuration:

```bash
# .env.local — git-ignored, server-side only
COMFY_API_KEY=your-comfy-cloud-api-key
```

Without the key the app still loads: import, playback, OCR verification and the JSON report work, while **Generate** returns an explicit "not configured" error instead of a fake job.

---

## The product workflow

1. **Product reference** — drop a pack shot (PNG/JPEG/WebP/AVIF, ≤ 25 MB). It is decoded locally. Optional: drag a **label area** rectangle, or let OCR read the photo to prefill the expected text.
2. **Brand contract** — enter the exact brand name (required) and the printed label text, one line per printed line. Pick **Luxury Studio**, **Sunset Outdoors** or **Neon City**, then edit the generated prompt if you like.
3. **Clip** — press **Generate with Comfy Cloud**. BrandProof ships the LTX-2.3 image-to-video workflow, converts it to API format, uploads the photo, injects the prompt, submits the real job, polls it, and pulls the returned MP4 back automatically. There is no workflow file to find or upload. Local ComfyUI remains for advanced users; **Import** accepts any MP4/WebM.
4. **Verify product fidelity** — choose strictness, coverage and sample count, then run.
5. **Evidence report** — verdict, critical checks, token matrix, filmstrip, OCR boxes, manual region re-run, and **Download JSON report**.

Everything after the clip exists is local.

---

## How verification actually works

### 1. Frame sampling

`sampleTimes()` picks evenly spaced timestamps from 4% to 96% of the clip duration (6, 12 or 18 frames; 12 by default), so early, middle and late portions are all represented. Each frame is seeked, drawn to its own canvas at up to **1920 px** wide, and stored as a JPEG thumbnail. Frame canvases are what OCR reads; the JPEGs are only for display.

More frames reduce the chance that a bad splice or brief distortion sits between samples, but they do not turn one good frame into proof for the whole clip. Each sampled frame is reported separately and the verdict uses the readable-frame coverage rule below.

If the browser cannot decode or seek the clip, verification stops with a concrete error instead of producing an empty report. MOV/HEVC clips usually fail here — re-encode to MP4/H.264 or WebM.

### 2. OCR

Tesseract.js 7 runs in a web worker with English (`eng`) model data. Every frame is read in several passes, then the words are merged:

1. **Full frame** — upscaled to a 2200 px long edge, sparse-text page segmentation (PSM 11).
2. **Label crop** — either the manually marked rectangle or an automatic crop derived from the best brand-word box, falling back to the densest text cluster. The crop is upscaled to an 1800 px long edge (up to 6×) before OCR.
3. **Crop variants** — original, grayscale, contrast-enhanced and adaptive-threshold images, using both **single-block** (PSM 6) and **sparse-text** (PSM 11) segmentation. If the normal threshold finds fewer than two words, an inverted threshold pass is added for light-on-dark labels.

That is typically 5–6 real Tesseract passes per sampled frame. Each pass returns its own word boxes and confidence values. Words with the same normalized text in the same place are merged (highest confidence wins); distinct instances stay separate. The merged text is grouped back into visual lines, and every box is mapped through the actual crop offset and scale into normalized 0–1 coordinates of the **full frame**.

`user_defined_dpi` is set to 300 for the upscaled inputs. Large or dense frames are still not tiled — that is a documented limitation. The report records the capture size, pass count per frame and whether OCR used a manual, automatic or no crop, so a missing line can be diagnosed instead of guessed at.

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

- brand matched in ≥ coverage of readable frames — or, when the word is present but its leading edge is clipped, full reads in ≥ 3 frames plus full-or-partial reads in ≥ coverage of readable frames, with no altered spelling anywhere;
- every configured label token matched in ≥ coverage of readable frames (skipped if no label text);
- readable frames ≥ required;
- legibility check passes;
- no critical check fails.

**FAIL** requires a demonstrable critical failure:

- readable text in ≥ 2 frames with confidence ≥ 50 but the brand never appears; or
- the brand appears altered (near matches) in ≥ 50% of readable frames and is matched in < 50%; or
- a label token is repeatedly read as a near miss (`visibly distorted`) in ≥ 2 readable frames while never matching; a single near reading is not enough to claim a change.

A label line that is simply absent from otherwise readable text is **NOT DETECTED**, not a confirmed mismatch. It produces REVIEW with an explanation that the label may be too small or blurred for OCR, and that the user should mark the label area or use a sharper clip. Likewise, frames where OCR cannot read the label are **UNREADABLE**, not failures.

**REVIEW** is everything else: insufficient readable frames, partial coverage, low OCR confidence, a single near reading, label text only partially found, or all expected label lines undetected.

**Duplicated lettering fails.** Every unmatched word is compared with the required tokens. A word that is at least 80% similar to a required word, is not a fragment or contraction of it, and appears in the same frame as the correct word, counts as a near-copy — for example `BOTANKA` printed above a correct `BOTANIKA`. Two or more readable frames with such a near-copy fail the critical **No duplicated lettering** check, because the render invented a second, garbled copy of text that should appear once. A single frame produces REVIEW, never FAIL. The offending reading, its similarity, confidence and box are recorded on that frame and in the JSON report.

**Every letter has to be read.** A required token counts as matched only when the reading contains the whole word. Word similarity alone is not enough: one dropped letter in an eight-letter brand scores 0.875, which clears the balanced 0.87 threshold, so a render printing `BOTANKA` on the body used to be reported as an exact `BOTANIKA` match. Readings that differ inside the word are now `near` (VISIBLY DISTORTED) however small the edit distance, and repeated in ≥ 2 frames they fail the brand check.

Two guards keep that rule from inventing a mismatch. A look-alike only counts when it sits in a **different place or at a different size** from the correct word — if a second OCR pass reads the same box differently (`BOTANIKA` in one pass, `BOTANKA` in another), that is one word, not a duplicate; but a smaller look-alike printed inside the area of a much larger word is extra lettering, not a re-read. And a word whose only difference is at its **start** (`TANIKA`, `UTANIKA`, `SOTANIKA` for `BOTANIKA`) is treated as a partially read word, because a clipped crop or a faint first glyph reads exactly that way; the brand check then reports *partially read* and the verdict is REVIEW, not FAIL.

Palette overlap is **advisory**: it can turn a PASS into REVIEW evidence but never forces FAIL, because a new scene legitimately changes the colour distribution.

### 5. Manual label region

If OCR fails, draw a rectangle on the product photo or on any evidence frame and re-run. The same normalized rectangle is cropped from every frame for both OCR and palette comparison. This assumes the label stays roughly in that screen position — appropriate for locked-off product shots, not for fast handheld moves. The UI says so.

### 6. Report

The JSON report (`brandproof-<brand>-<timestamp>.json`) contains:

- `verdict`, `headline`, `summary`, `schemaVersion: "brandproof.report/1"`;
- full config: text, scene, strictness, computed threshold, coverage, sample count, region;
- checks with status, criticality, metric and explanation;
- metrics: readable frames, brand/label recall, mean confidence, palette similarity;
- token evidence with per-token hit/near/missing/unreadable counts, best reading/confidence and a finding (`verified`, `detected`, `visibly-distorted`, `not-detected`, `unreadable` or `insufficient-evidence`);
- every frame: time, dimensions, legible flag, status, recognized text, all merged words with normalized boxes and confidence, the OCR passes that ran, and the crop region/source;
- diagnostics: capture resolution, requested vs captured frames, pass counts per frame and region sources;
- limitations.

Frame images are deliberately **not** embedded in the JSON; they stay in the browser.

---

## Video generation: Comfy Cloud API (primary) + local ComfyUI (advanced)

### Direct Comfy Cloud execution

BrandProof runs the workflow itself through **Comfy API v2**. There is no “open Comfy Cloud and download the file yourself” step. The server-side proxy uses the documented endpoints:

| Step | Comfy Cloud endpoint |
| --- | --- |
| Upload the product photo | `POST https://cloud.comfy.org/api/v2/assets` |
| Submit the API-format graph | `POST https://cloud.comfy.org/api/v2/jobs` |
| Poll the real job | `GET https://cloud.comfy.org/api/v2/jobs/{id}` |
| Download the returned MP4 | `GET https://cloud.comfy.org/api/v2/assets/{id}/content` |

The browser only calls same-origin `/api/comfy/*` routes. In production those are handled by [`worker/comfy-cloud.js`](worker/comfy-cloud.js); locally the same module runs inside Vite middleware. The key is sent only as an `Authorization: Bearer …` header to `cloud.comfy.org` and never to the browser or to the signed storage host.

[Comfy API v2 overview](https://docs.comfy.org/api-reference/v2/overview) · [Submit a workflow](https://docs.comfy.org/api-reference/v2/jobs/submit-a-workflow-for-execution) · [Job status](https://docs.comfy.org/api-reference/v2/jobs/job-status-the-polling-workhorse) · [Upload an asset](https://docs.comfy.org/api-reference/v2/assets/upload-an-asset-single-call-multipart)

### What the app actually does on Generate

1. Loads the bundled **LTX-2.3 UI workflow**, converts its subgraph to an API graph in the browser, and validates the photo/prompt/video bindings.
2. Uploads the product photo to Comfy Cloud assets and receives an asset id.
3. Injects a real `core/ASSET` reference into every `LoadImage` node:
   ```json
   {"__type":"core/ASSET","info":{"id":"asset_…","hash":"blake3:…","file_path":"brandproof-….png"}}
   ```
4. Injects the prepared BrandProof prompt into the positive text node(s), the negative prompt by title, and the seed if present.
5. Submits the graph to `POST /api/v2/jobs` with an idempotency key, then polls the actual job.
6. Streams the returned video asset bytes through the Worker and hands the real MP4 to the player.
7. Starts BrandProof's own OCR verification automatically when a brand name is set.

If Comfy Cloud rejects the workflow, runs out of credits, or fails a node, the error is shown verbatim. The UI never invents progress or a successful video.

### Required Comfy Cloud setup

1. Sign in at [platform.comfy.org](https://platform.comfy.org) with the account registered for the Build Night workspace.
2. Open **API Keys → + New**, create a key, and save it once.
3. Add it as the project secret **`COMFY_API_KEY`** in **Settings → Secrets**, then redeploy so the Worker receives it.
4. For local development only, put `COMFY_API_KEY=…` in `.env.local` (ignored by git). Never use a `VITE_` prefix.

The key must belong to the workspace/account holding the credits. Comfy's Cloud docs currently describe API access as a paid-plan feature; having a credit balance does not by itself guarantee API entitlement. BrandProof cannot create, upgrade or bypass that entitlement. If the key is absent or rejected, the UI says so instead of pretending to generate.

### Workflow requirements

BrandProof ships the LTX-2.3 image-to-video graph in [`src/workflows/ltx23_i2v.json`](src/workflows/ltx23_i2v.json). It is the ordinary Comfy UI workflow (with one `Image to Video (LTX-2.3)` subgraph), so the browser flattens the subgraph, maps linked inputs and constants, resolves reroutes/primitive nodes, and sends an API graph to the Worker. The Worker validates the API graph again; it never accepts a UI graph as if it were executable.

No workflow upload, API-format export or paste step is exposed in the normal UI. The app has a fixed workflow for this hackathon build. Comfy V3 dynamic-combo inputs keep their group prefix in the API graph, so the converter preserves names such as `resize_type.crop`, `resize_type.longer_size`, `sampling_mode.min_p` and `values.a`; flattening them to `crop`, `longer_size`, `min_p` or `a` makes Comfy reject the prompt with `required_input_missing`. If a bundled node is muted/bypassed or uses `GetNode`/`SetNode`, conversion stops with a specific error instead of guessing.

The bundled workflow must contain:

- at least one **`LoadImage`** node;
- at least one text node with an **`inputs.text`** string (positive prompt; the default LTX negative prompt is detected and kept separate);
- at least one video output node: **`SaveVideo`**, **`SaveWEBM`** or **`VHS_VideoCombine`**.

The bundled Wan 2.2 workflow in [`comfy/workflows/wan22_ti2v_api.json`](comfy/workflows/wan22_ti2v_api.json) is for the **local** path only. It is not used for Comfy Cloud and is not substituted for LTX-2.3.

The public [LTX-2.3 Image-to-Video page](https://comfy.org/workflows/video_ltx2_3_i2v-7cc1d3bd2802/) documents the model and inputs. BrandProof's copy is bundled so a judge can generate without touching a workflow file.

### Advanced: local ComfyUI

The local path remains for users who already have a GPU and ComfyUI. It uses the real ComfyUI HTTP API (`/system_stats`, `/upload/image`, `/prompt`, `/history`, `/queue`, `/view`) and the bundled Wan 2.2 API workflow. It is **not** required for the Comfy Cloud workflow.

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

### Fallback import

If you already have a clip, **Import MP4** still loads it, starts verification when a brand is set, and reports the OCR evidence. A generation prompt is never treated as proof that the label survived; only the frames are.

---

## Testing the full workflow

### Small-label regression test (BOTANIKA / LTX-2.3)

The repository does **not** ship the BOTANIKA clip or pack shot. Use your own files:

1. Run `npm install && npm run dev` and open the preview URL.
2. Upload the BOTANIKA product photo. Enter `BOTANIKA` as the brand and the three label lines exactly as printed:
   `HYDRATING`, `MOISTURIZER`, `NATURAL INGREDIENTS · PLANT POWERED`.
3. Import the LTX-2.3 MP4. Choose **12 frames** (or **18** for a longer clip) and keep **Balanced** + 60% coverage.
4. Run verification **once without marking a label area**. Open **Capture & OCR diagnostics** and the per-frame facts. Check the capture resolution, pass count, region source and word count.
5. If the label lines are **NOT DETECTED**, draw a box tightly around the printed label on an evidence frame and press **Re-run with this area**. The manual region takes priority over the automatic crop.
6. Compare early, middle and late frames in the filmstrip. A line that is readable in one frame and absent in others is not a PASS for the whole clip; the coverage rule and per-frame statuses show that.
7. Open **Token coverage**. `NOT DETECTED` and `UNREADABLE` are insufficient-evidence states, not proof of a changed label. Only repeated near-readings labelled **VISIBLY DISTORTED** should produce a label FAIL.
8. Download the JSON report and inspect `diagnostics`, each frame's `ocrPasses`/`ocrRegionSource`, and each token's `finding`.

### Test input photo

The demo input ships with the repository: [`public/test/brown_moisturizer_bottle.jpg`](public/test/brown_moisturizer_bottle.jpg), a portrait pack shot of the BOTANIKA pump bottle. Printed text, top to bottom: `HYDRATING`, `MOISTURIZER`, `BOTANIKA`, `NATURAL INGREDIENTS · PLANT POWERED`.

![BOTANIKA test input pack shot](public/test/brown_moisturizer_bottle.jpg)

Use it as the product reference, enter `BOTANIKA` as the brand, and the three label lines as checks. It is also served at `/test/brown_moisturizer_bottle.jpg` on any deployment. How it is used: [`public/test/README.md`](public/test/README.md).

### Fast test with a real clip

1. `npm install && npm run dev`, open the app.
2. Upload a product photo where the label is readable (a real product shot or a screenshot of packaging).
3. Type the brand name exactly, then the label lines. Optionally press **Scan photo** and click `+ label` on recognized lines.
4. Pick a scene, keep or edit the prompt.
5. Import a short clip (2–6 s) that shows the product. Generate one through **Comfy Cloud** (the primary path), use local ComfyUI, or make a deterministic fixture from the pack shot:

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
- Add a label line that is definitely not printed, keep "Treat missing label text as critical" on, and re-run: expect **REVIEW** with `NOT DETECTED` token evidence, not an invented FAIL. A missing line is not proof that the label changed.
- Change one letter in a label line that was previously read clearly, then re-run: if OCR repeatedly reads the altered near-miss, the label check should FAIL as `VISIBLY DISTORTED`.
- Import a clip with no visible text: expect REVIEW with a failing legibility check, not a fake PASS.
- Lower the sample count to 6 and raise coverage to 90% to see coverage-driven REVIEW.

### Automated checks

```bash
npm test        # 71 unit tests: normalization, OCR preprocessing, verdicts, report export, bundled workflow conversion, Comfy Cloud v2 proxy, local ComfyUI client
npm run build   # typecheck + production build
```

The Comfy Cloud v2 proxy is unit-tested with mocked Cloud responses: asset upload, `core/ASSET` injection, prompt binding, job submission, status sanitization, signed-URL download without forwarding the key, animated-image rejection, and unsupported-workflow refusal. UI→API conversion is tested with a subgraph fixture, including linked image/prompt inputs and the negative-prompt node. The bundled LTX-2.3 workflow is tested end to end through parsing, server validation and `core/ASSET` binding. **Actual Comfy Cloud generation is not executed in this repository's automated tests** because it requires a live `COMFY_API_KEY` and consumes workspace credits. A real run requires the key/API entitlement described above. End-to-end local generation requires a GPU and local ComfyUI, so it is also not run in CI.

### Known runtime dependency

Tesseract.js downloads its WASM engine and the `eng` traineddata from the jsDelivr CDN on first OCR use (then caches in IndexedDB). If that CDN is blocked, OCR fails with an explicit message. To self-host, copy the Tesseract worker/core/`eng.traineddata.gz` assets into `public/` and set `workerPath` / `corePath` / `langPath` in `src/lib/ocr.ts` — see the [Tesseract.js local installation guide](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md).

---

## Catalog Pilot Run (new in v2)

> **Added after the Build Night award.** Everything above this line describes v1 — Studio, the build that was demoed and awarded on 28 October 2026. This section is the addition; it was not part of that event.
>
> Own deployment: **https://site-f6bf20b690ba408e8078305a9210b7a8.freebuff.page**

A catalog run takes several products at once, generates a clip for each through the same bundled LTX-2.3 workflow on Comfy Cloud, and verifies every returned MP4 with the same OCR pipeline the studio uses. It runs as its own deployment, so the awarded Studio demo is untouched.

**A batch, plus a loop.** Running 8 products is the scale; the part that differs from v1 is what happens after each clip arrives. Verification is not the last step of a job here — it is the controller of the job. A product is finished only when its own MP4 passes the existing checks; otherwise BrandProof changes the next generation using the evidence it just produced, and keeps going until PASS or three attempts.

### What a run does

1. You add up to 8 products, each with a photo and a required brand name, plus optional label lines to check and optional direction. **Scan photo** OCRs the uploaded pack shot in the browser and offers `set brand` / `+ label` on the lines it actually recognises, so the expected text can be copied instead of retyped; label lines are optional, and with none the brand name is the only check.
2. On **Start catalog run**, the Worker creates a budgeted run in D1 before anything is generated.
3. Products are processed **concurrently** up to the configured limit (default 3, max 4), each in its own lane. A slow product never blocks another.
4. Every generation attempt must first reserve credits server-side (`POST /api/catalog/runs/:id/reservations`). Concurrent attempts cannot reserve the same credits; the gate is a conditional `UPDATE … WHERE spent + reserved + cost <= budget` inside D1.
5. The returned MP4 is verified by `analyzeVideo` — frame sampling, multi-pass Tesseract OCR, token matching and the normal PASS/REVIEW/FAIL rules. Nothing about verification is relaxed for the catalog.
6. **The video is iterated on, not merely counted.** A genuine PASS approves the product and ends its loop at once — a passing product is never regenerated. FAIL or REVIEW is treated as a reason to change the generation rather than a final answer: BrandProof records the evidence and, while attempts remain, regenerates that product with a **targeted revision** derived from the recorded token findings (label not detected → stable front-facing label and less camera movement; visibly distorted → minimal product motion and a steady camera; unreadable → closer, unobstructed, evenly lit label).
7. **The loop terminates honestly.** After 3 total attempts a product becomes **Needs human review** — REVIEW is never promoted to approved and thresholds are never relaxed to manufacture a PASS. Each attempt keeps its own clip, verdict, evidence, revision and reason, so a human sees exactly what was tried. The rest of the catalog keeps running.

**Every attempt keeps its clip.** The results board stores each attempt's MP4 separately and shows it inside that attempt, with its own download link, so a retry never overwrites the video that failed. The card preview follows the newest attempt until the product is approved. Clips live in the tab's memory as blob URLs — they survive retries and page state changes, but not a reload, which is why each product and the run also export JSON evidence.

### Budget model and what is actually enforced

- Comfy Cloud API v2 does **not** report per-job credit usage, so the app never claims provider billing. Each attempt is charged against the run budget at a configurable planning rate (`CATALOG_ESTIMATE_CREDITS_PER_ATTEMPT`, default 1 credit) plus a 15% safety margin — 1.15 credits per attempt by default. Every figure in the UI and exports is labelled **estimate**.
- Run budget and the deployment-wide daily cap (`CATALOG_DAILY_CREDIT_CAP`, default 30 credits) are enforced **server-side** in D1, so they hold across Worker isolates and across browser tabs. A denied attempt returns `budget-limited` and starts no generation.
- Reserving is idempotent per attempt id, so a retried HTTP call cannot double-charge.
- **Concurrency is limited by the browser tab**, not by the Worker: the Worker grants spend, the client decides how many products are in flight. A Durable Object would be needed for server-side concurrency; the platform's managed deploy does not support custom Durable Objects, so this is stated rather than faked.
- OCR runs through a single Tesseract worker, so verification of concurrent products is queued behind one engine while generation stays parallel.

### Reliability

- Every run, product and attempt has its own id; generation is submitted with the attempt id as its idempotency key.
- Run state is saved to `localStorage` after every transition. On reload, products that had not reached a verdict are marked **interrupted** with the Comfy job id where one exists — the app never silently resubmits a generation.
- One product erroring, timing out or exhausting attempts never cancels the run.

### Exports

- **CSV** — one row per product (status, attempts, approved, final verdict, failed checks, sampled frames, estimated credits, video, job ids).
- **Batch JSON** — run configuration, metrics, every attempt's evidence and the full verification report where this tab still holds it.
- **Per-product JSON** — the standard BrandProof report when available; otherwise the stored OCR evidence with an explicit note that the video and frame images are gone after a reload.

### Not included

- No sample/demo mode: there are no prerecorded catalog results in this repository, so none are presented as live.
- No accounts, billing, or catalog management beyond one run in the browser.
- Label text only: the catalog does not verify product shape, ingredients, legal claims or overall authenticity.

### Setting it up

The pilot site needs two things in its own environment, neither of which touches the main site:

1. a D1 database bound as `CATALOG_DB` (the Worker creates its tables on first use), and
2. `COMFY_API_KEY` as a project secret on that environment, so generation can run.

Without the secret the UI still loads and the ledger still works, but **Start catalog run** stops at the first generation with Comfy's own `not configured` error. That message is real, not simulated.

## Limitations

- **OCR is not a forensic check.** Tiny, curved, embossed, engraved, reflective or motion-blurred text can stay unreadable even for a human; BrandProof reports that as low legibility.
- **Small text can be missed even with the new passes.** The automatic label crop is a heuristic based on the brand box or densest text cluster; it can clip surrounding lines. If a line is undetected, mark the label area manually and re-run before treating it as a label change.
- **NOT DETECTED is not a mismatch.** An OCR miss produces REVIEW (or `insufficient-evidence`), not FAIL. FAIL for label text requires repeated near-readings that look like visible distortion, not silence.
- **Sampling is discrete.** Incorrect text that appears only between sampled frames can be missed. Raise sample count for fast cuts.
- **Text only, plus a colour heuristic.** There is no logo-shape matching, structural comparison or audio analysis. Palette overlap is a coarse 4×4×4 RGB histogram intersection, not identity.
- **Media loading has a fallback, not a guarantee.** Verification opens the downloaded clip from memory first; if the browser stalls at `readyState 0` (a blob can queue behind other downloads), the same bytes are reopened from the same-origin Worker stream at `/api/comfy/jobs/<id>/video`. If neither loads, the report names both failures with byte size, MIME type and container instead of a bare timeout.
- **One product per verification in Studio.** v2's catalog pilot verifies up to 8 products, but each against its own photo and its own clip — never as one shared frame set. Multiple labels on one pack, multi-language packs and full-frame reading can produce noisy OCR; use the label region.
- **Region OCR assumes stable framing.** A moving label invalidates the fixed rectangle.
- **No server trust layer.** Reports are browser-generated and unsigned; anyone can edit a downloaded JSON.
- **Browser codec support.** MP4/H.264 and WebM are supported; MOV/HEVC usually is not. Frame seeking can fail on exotic codecs.
- **Comfy Cloud API access is required.** The proxy uses `COMFY_API_KEY`; Comfy's docs describe API access as a paid-plan feature. Build Night workspace credits do not by themselves guarantee API entitlement. BrandProof cannot create, upgrade or bypass that access.
- **Your workflow must match the binding contract.** It needs a `LoadImage` node, a text prompt node, and a `SaveVideo`/`SaveWEBM`/`VHS_VideoCombine` output. API and UI formats are supported; UI graphs with muted/bypassed nodes or `GetNode`/`SetNode` are rejected with a specific error rather than guessed at.
- **Generation state is not persisted.** BrandProof keeps the job id in the current tab. If you refresh, it loses the poller; the Comfy job may continue and consume workspace credits. Reopening the job is not exposed in this UI.
- **Local generation requires your own ComfyUI.** Models, VRAM and queue time are yours to manage. CORS and mixed content can block a local endpoint; start ComfyUI with `--enable-cors-header` and serve the app over HTTP or proxy ComfyUI over HTTPS.

---

## Publish the live app for free

The submission build is already live at <https://site-ebd712779b3a4bf1879d40dc062c2b30.freebuff.page> (Production, key bound). The steps below reproduce that deployment from scratch.

BrandProof deploys as static `dist/` assets plus a Worker that serves `/api/comfy/*` and the SPA. Direct generation only works when the Worker and the `COMFY_API_KEY` secret are deployed together.

### Option A — Freebuff Sites (recommended, free)

1. Run the production build:

   ```bash
   npm run build
   ```

2. In the Sites panel, create a project (e.g. `brandproof`).
3. Deploy the prebuilt manifest [`deploy.json`](deploy.json). It serves `dist/`, routes `/api/comfy/*` through `worker/index.js` + `worker/comfy-cloud.js`, and falls back to the SPA.
4. Add **`COMFY_API_KEY`** in **Settings → Secrets** (the key is never shown in the app or committed to the repo).
5. Redeploy so the Worker receives the secret. Reload the preview: the setup card should disappear.
6. Generate once with the bundled LTX-2.3 workflow, verify the returned MP4, then publish when you are happy.

No D1 databases, R2 buckets or auth bindings are required. If you redeploy after changing code or rotating the key, rebuild first so `dist/` is current.

### Option B — Cloudflare Pages (static only)

- Framework preset: none / Vite
- Build command: `npm run build`
- Output directory: `dist`

A static Pages deployment serves the UI but not `/api/comfy/*`, so generation returns the explicit “not configured” error. Use Pages Functions or the included Worker manifest if you need direct generation.

### Option C — Netlify / Vercel / GitHub Pages

A static host serves the UI, import and verification, but not the Comfy proxy. Port [`worker/comfy-cloud.js`](worker/comfy-cloud.js) to a serverless function at `/api/comfy/*` and set `COMFY_API_KEY` there if you need direct generation. If hosting under a subpath (GitHub Pages), set Vite's `base` in `vite.config.ts` to that path before building.

### After deploying

- OCR still loads its engine/model from jsDelivr, so the visitor needs access to that CDN.
- The Worker needs the `COMFY_API_KEY` secret; adding it without redeploying leaves the status endpoint reporting `configured: false`.
- A deployed HTTPS page cannot call a local `http://` ComfyUI due to mixed content. Comfy Cloud generation works from HTTPS; local ComfyUI is best on a local/HTTP build or behind an HTTPS proxy.
- Test one **real Comfy Cloud generate → automatic MP4 load → OCR report → JSON download** on the deployed URL. Also test the import fallback. If Comfy rejects the key, the UI will show the Cloud error; check the workspace entitlement before changing app code.

---

## Repository, contributing and license

- **Repository:** https://github.com/yfandev/brandproof
- **Clone:** `git clone https://github.com/yfandev/brandproof.git`

The repository is ready to publish as-is: [MIT license](LICENSE), no secrets, no committed API keys, no committed build output (`dist/`, `freebuff-sites-build/` are git-ignored) and no generated video assets.

### Bug reports

Open an issue at https://github.com/yfandev/brandproof/issues and include:

- what you did (photo type, whether the clip came from Comfy Cloud or an import, sample count, strictness, coverage);
- the exact UI error or verdict you saw;
- the downloaded JSON report when the problem is an OCR result — it contains the recognized words, boxes and passes, and contains no video frames and no key;
- browser and OS.

Never paste an API key or a private `COMFY_API_KEY` value into an issue. Revoke and re-create a key at [platform.comfy.org](https://platform.comfy.org) if one leaks.

### Pull requests

1. Fork the repository and create a branch from `main`.
2. Install with `npm install`; `.env.local` with your own key is only needed for the generation path.
3. Keep `npm run typecheck`, `npm test` and `npm run build` green before opening the PR.
4. Describe any change to sampling, OCR passes or the verdict thresholds: those change what a PASS means, so they need a short rationale and, where feasible, a test.
5. Do not add secrets, telemetry, paid services or mock results that could be mistaken for live ones.

### License

Released under the [MIT License](LICENSE) — Copyright (c) 2026 yfandev. Tesseract.js is Apache-2.0; ComfyUI, the LTX-2.3 model and the optional Wan 2.2 models carry their own licenses and are not redistributed here.

This repository is a hackathon submission prepared for public release. The project was awarded a **top-three placement at Comfy Build Nights in San Francisco on 28 October 2026**; that event's award list is unranked among the top three. That is the build-night result only. The online [Comfy Open Source × Higgsfield competition](https://comfy.org/open-source-higgsfield) is a separate entry rather than a later round, and eligibility, judging and any result there are decided by the organisers; no result in that competition is claimed here.

---

## Project structure

```
comfy/workflows/wan22_ti2v_api.json  documented API-format Wan 2.2 workflow (local only)
deploy.json                          Sites manifest: assets + API worker
worker/index.js                      routes /api/comfy/* and ASSETS
worker/comfy-cloud.js                Comfy v2 proxy: upload, submit, poll, MP4 stream
worker/dev-server.js                 Vite middleware for the same proxy
src/
  workflows/ltx23_i2v.json           bundled LTX-2.3 image-to-video UI workflow
  App.tsx                            workflow state and page composition
  components/
    ProductPanel.tsx                 upload, palette, label-region, reference OCR
    BriefPanel.tsx                   brand text, scene presets, editable prompt
    VideoPanel.tsx                   cloud/local/import tabs, player, source metadata
    ComfyCloudPanel.tsx              bundled workflow status, direct Comfy Cloud generation, progress
    ComfyPanel.tsx                   advanced local endpoint, workflow editor, generation log
    VerifyPanel.tsx                  strictness/coverage controls and progress
    EvidenceReport.tsx               verdict, checks, filmstrip, boxes, token matrix
    RegionPicker.tsx                 normalized drag-rectangle selector
  lib/
    analyze.ts                       sampling → OCR → palette → report pipeline
    frames.ts                        seek/canvas frame capture
    preprocess.ts                    grayscale/contrast/threshold, crop mapping, word merge
    ocr.ts                           multi-pass Tesseract.js worker and region selection
    text.ts                          normalization, candidate building, similarity
    verdict.ts                       frame evaluation, rules, report assembly
    cloud.ts                         Comfy API client + workflow validation
    defaultWorkflow.ts               bundled LTX-2.3 workflow export
    workflowConvert.ts               UI workflow/subgraph → API graph conversion
    comfy.ts                         local ComfyUI API client + workflow binding
    image.ts                         reference decode, palettes, crops
    video.ts                         file validation and metadata probing
    report.ts                        JSON export/download
  styles.css                        dark studio design system
```

**Privacy:** imported clips, sampled frames and reports stay in the browser tab. Pressing **Generate** sends the product photo and workflow to Comfy Cloud through the Worker; the API key never reaches the browser. OCR assets come from jsDelivr, and local ComfyUI is called only at the endpoint you enter.

**License:** [MIT](LICENSE). Tesseract.js is Apache-2.0; ComfyUI and the Wan 2.2 models carry their own licenses.
