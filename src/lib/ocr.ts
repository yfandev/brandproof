import { createWorker, PSM } from 'tesseract.js';
import type {
  Bbox,
  OcrPassInfo,
  OcrRegionSource,
  OcrWord,
  Rect,
} from '../types';
import {
  OCR_CROP_LONG_EDGE,
  OCR_FULL_FRAME_LONG_EDGE,
  cropCanvasWithMeta,
  densestTextRegion,
  deriveLabelRegion,
  labelBlockBbox,
  mapBboxToFrame,
  mergeOcrWords,
  preprocessCanvas,
  upscaleForOcr,
  type CropTransform,
  type PreprocessVariant,
} from './preprocess';
import { buildCandidates, matchTokens, normalizeText, textFromWords } from './text';

export class OcrError extends Error {}

export interface OcrResult {
  words: OcrWord[];
  text: string;
  confidence: number;
  passes: OcrPassInfo[];
  region: Rect | null;
  regionSource: OcrRegionSource;
}

export interface OcrOptions {
  region?: Rect | null;
  /** Brand tokens used to anchor an automatic label crop after the first pass. */
  focusTokens?: string[];
  /** Off for a quick full-photo scan; on for verification. */
  autoRegion?: boolean;
  thorough?: boolean;
  onProgress?: (progress: number, status: string) => void;
  onEngineStatus?: (status: string) => void;
}

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

interface PassSpec {
  id: string;
  label: string;
  variant: PreprocessVariant;
  psm: PSM;
}

const FULL_PASS: PassSpec = {
  id: 'full-original',
  label: 'Full frame · original · sparse',
  variant: 'original',
  psm: PSM.SPARSE_TEXT,
};

const FULL_CONTRAST_PASS: PassSpec = {
  id: 'full-contrast',
  label: 'Full frame · contrast · sparse',
  variant: 'contrast',
  psm: PSM.SPARSE_TEXT,
};

const CROP_PASSES: PassSpec[] = [
  {
    id: 'crop-original-block',
    label: 'Label crop · original · block',
    variant: 'original',
    psm: PSM.SINGLE_BLOCK,
  },
  {
    id: 'crop-grayscale-block',
    label: 'Label crop · grayscale · block',
    variant: 'grayscale',
    psm: PSM.SINGLE_BLOCK,
  },
  {
    id: 'crop-contrast-block',
    label: 'Label crop · contrast · block',
    variant: 'contrast',
    psm: PSM.SINGLE_BLOCK,
  },
  {
    id: 'crop-threshold-block',
    label: 'Label crop · adaptive threshold · block',
    variant: 'threshold',
    psm: PSM.SINGLE_BLOCK,
  },
  {
    id: 'crop-original-sparse',
    label: 'Label crop · original · sparse',
    variant: 'original',
    psm: PSM.SPARSE_TEXT,
  },
];

const CROP_INVERTED_PASS: PassSpec = {
  id: 'crop-threshold-inverted-block',
  label: 'Label crop · inverted threshold · block',
  variant: 'threshold-inverted',
  psm: PSM.SINGLE_BLOCK,
};

const CROP_FAST_PASSES: PassSpec[] = CROP_PASSES.slice(0, 3);

let workerPromise: Promise<TesseractWorker> | null = null;
let progressHandler: ((progress: number, status: string) => void) | null = null;
let engineStatusHandler: ((status: string) => void) | null = null;

const ENGINE_HINTS: Record<string, string> = {
  'loading tesseract core': 'Loading OCR engine',
  'initializing tesseract': 'Initialising OCR engine',
  'loading language traineddata': 'Loading English model',
  'initializing api': 'Warming up OCR',
};

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      logger: (message) => {
        if (message.status === 'recognizing text') {
          progressHandler?.(message.progress, message.status);
        } else {
          engineStatusHandler?.(ENGINE_HINTS[message.status] ?? message.status);
        }
      },
    })
      .then(async (worker) => {
        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
        });
        return worker;
      })
      .catch((error: unknown) => {
        workerPromise = null;
        const detail = error instanceof Error ? error.message : String(error);
        throw new OcrError(
          `The OCR engine could not start: ${detail}. Tesseract.js downloads its engine and the English model from the jsDelivr CDN on first use, so check your connection or self-host those assets (see README).`,
        );
      });
  }
  return workerPromise;
}

export async function disposeOcr(): Promise<void> {
  const current = workerPromise;
  workerPromise = null;
  progressHandler = null;
  engineStatusHandler = null;
  if (current) {
    try {
      const worker = await current;
      await worker.terminate();
    } catch {
      // Terminating a failed worker is best-effort.
    }
  }
}

function collectWords(blocks: unknown): Array<{ text: string; confidence: number; bbox: Bbox }> {
  const output: Array<{ text: string; confidence: number; bbox: Bbox }> = [];
  if (!Array.isArray(blocks)) return output;

  for (const block of blocks) {
    const paragraphs = (block as { paragraphs?: unknown }).paragraphs;
    if (!Array.isArray(paragraphs)) continue;
    for (const paragraph of paragraphs) {
      const lines = (paragraph as { lines?: unknown }).lines;
      if (!Array.isArray(lines)) continue;
      for (const line of lines) {
        const words = (line as { words?: unknown }).words;
        if (!Array.isArray(words)) continue;
        for (const word of words) {
          const candidate = word as {
            text?: unknown;
            confidence?: unknown;
            bbox?: { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
          };
          const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
          const bbox = candidate.bbox;
          if (!text || !bbox) continue;
          const { x0, y0, x1, y1 } = bbox;
          if (
            typeof x0 !== 'number' ||
            typeof y0 !== 'number' ||
            typeof x1 !== 'number' ||
            typeof y1 !== 'number'
          ) {
            continue;
          }
          output.push({
            text,
            confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0,
            bbox: { x0, y0, x1, y1 },
          });
        }
      }
    }
  }
  return output;
}

interface PassResult {
  words: OcrWord[];
  info: OcrPassInfo;
}

async function runPass(
  worker: TesseractWorker,
  source: HTMLCanvasElement,
  spec: PassSpec,
  transform: CropTransform,
  onProgress: ((value: number) => void) | undefined,
): Promise<PassResult> {
  const input = preprocessCanvas(source, spec.variant);
  await worker.setParameters({
    tessedit_pageseg_mode: spec.psm,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });

  progressHandler = (value) => onProgress?.(Math.max(0, Math.min(1, value)));
  engineStatusHandler = null;

  try {
    const { data } = await worker.recognize(input, {}, { blocks: true, text: true });
    const words: OcrWord[] = collectWords(data.blocks)
      .map((word) => {
        const bbox = mapBboxToFrame(word.bbox, transform);
        const normalized = normalizeText(word.text);
        return {
          text: word.text,
          normalized,
          confidence: Math.round(word.confidence * 10) / 10,
          bbox,
        };
      })
      .filter(
        (word) =>
          word.normalized.length > 0 &&
          word.bbox.x1 > word.bbox.x0 &&
          word.bbox.y1 > word.bbox.y0,
      );

    return {
      words,
      info: {
        id: spec.id,
        label: spec.label,
        psm: Number(spec.psm),
        variant: spec.variant,
        wordCount: words.length,
        confidence:
          typeof data.confidence === 'number' ? Math.round(data.confidence * 10) / 10 : 0,
      },
    };
  } finally {
    progressHandler = null;
  }
}

function anchorRegion(words: OcrWord[], focusTokens: string[]): Rect | null {
  if (words.length === 0) return null;

  if (focusTokens.length > 0) {
    const matches = matchTokens(focusTokens, buildCandidates(words), 0.62, 25)
      .filter((match) => match.bbox && match.similarity >= 0.62)
      .sort((a, b) => b.similarity - a.similarity);
    const best = matches[0];
    if (best?.bbox) {
      // Grow the anchor to the whole label block first: the required lines are
      // printed above and below the brand, and a brand-only crop cut them off.
      const block = labelBlockBbox(
        best.bbox,
        words.map((word) => word.bbox),
      );
      const region = deriveLabelRegion(block);
      if (region) return region;
    }
  }

  return densestTextRegion(words);
}

function meanConfidence(words: OcrWord[]): number {
  if (words.length === 0) return 0;
  return (
    Math.round(
      (words.reduce((total, word) => total + word.confidence, 0) / words.length) * 10,
    ) / 10
  );
}

/**
 * Runs a full-frame pass, derives a label crop from the brand or the densest
 * text cluster, then re-runs several preprocessing/PSM variants on that crop.
 * Every returned word keeps its real full-frame box and confidence.
 */
export async function recognizeCanvas(
  canvas: HTMLCanvasElement,
  options: OcrOptions = {},
): Promise<OcrResult> {
  const manualRegion = options.region ?? null;
  const thorough = options.thorough ?? true;
  const autoRegion = options.autoRegion ?? false;
  const passes: OcrPassInfo[] = [];
  const collected: OcrWord[] = [];
  let successfulPasses = 0;
  let firstError: string | null = null;

  const worker = await getWorker();

  const run = async (
    spec: PassSpec,
    source: HTMLCanvasElement,
    transform: CropTransform,
    rangeStart: number,
    rangeEnd: number,
  ): Promise<PassResult | null> => {
    progressHandler = null;
    engineStatusHandler = options.onEngineStatus ?? null;
    try {
      const result = await runPass(worker, source, spec, transform, (value) => {
        options.onProgress?.(rangeStart + (rangeEnd - rangeStart) * value, spec.label);
      });
      successfulPasses += 1;
      passes.push(result.info);
      collected.push(...result.words);
      options.onProgress?.(rangeEnd, spec.label);
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      firstError ??= detail;
      passes.push({
        id: spec.id,
        label: spec.label,
        psm: Number(spec.psm),
        variant: spec.variant,
        wordCount: 0,
        confidence: 0,
        error: detail,
      });
      return null;
    }
  };

  const fullUpscaled = upscaleForOcr(canvas, OCR_FULL_FRAME_LONG_EDGE);
  const fullTransform: CropTransform = {
    frameWidth: canvas.width,
    frameHeight: canvas.height,
    cropX: 0,
    cropY: 0,
    scale: fullUpscaled.width / Math.max(1, canvas.width),
  };

  const fullResult = await run(
    FULL_PASS,
    fullUpscaled,
    fullTransform,
    0,
    manualRegion || autoRegion ? 0.3 : 0.45,
  );
  const fullWords = fullResult?.words ?? [];

  let region: Rect | null = manualRegion;
  let regionSource: OcrRegionSource = manualRegion ? 'manual' : 'full-frame';

  if (!region && autoRegion) {
    region = anchorRegion(fullWords, options.focusTokens ?? []);
    if (region) regionSource = 'auto';
  }

  if (region && (manualRegion || autoRegion)) {
    const crop = cropCanvasWithMeta(canvas, region);
    const cropUpscaled = upscaleForOcr(crop.canvas, OCR_CROP_LONG_EDGE);
    const transform: CropTransform = {
      frameWidth: canvas.width,
      frameHeight: canvas.height,
      cropX: crop.crop.x,
      cropY: crop.crop.y,
      scale: cropUpscaled.width / Math.max(1, crop.crop.w),
    };

    const specs = thorough ? CROP_PASSES : CROP_FAST_PASSES;
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      const start = 0.3 + (0.68 * index) / specs.length;
      const end = 0.3 + (0.68 * (index + 1)) / specs.length;
      const result = await run(spec, cropUpscaled, transform, start, end);

      // White-on-dark packaging often needs the inverse threshold. Only pay for
      // it when the normal threshold pass found almost nothing.
      if (
        thorough &&
        spec.variant === 'threshold' &&
        result &&
        result.words.length < 2
      ) {
        await run(CROP_INVERTED_PASS, cropUpscaled, transform, end, Math.min(0.98, end + 0.04));
      }
    }
  } else if (!manualRegion) {
    // No reliable crop. Keep a contrast full-frame pass as a fallback.
    await run(FULL_CONTRAST_PASS, fullUpscaled, fullTransform, 0.45, 0.98);
  }

  if (successfulPasses === 0) {
    throw new OcrError(
      `OCR failed on every pass${firstError ? `: ${firstError}` : '.'} Try importing the clip again or mark the label area manually.`,
    );
  }

  const words = mergeOcrWords(collected);
  const text = textFromWords(words);

  options.onProgress?.(1, 'OCR complete');
  return {
    words,
    text,
    confidence: meanConfidence(words),
    passes,
    region,
    regionSource: region ? regionSource : 'full-frame',
  };
}
