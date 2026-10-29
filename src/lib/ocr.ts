import { createWorker, PSM } from 'tesseract.js';
import type { OcrWord, Rect } from '../types';
import { cropNormalized } from './image';
import { normalizeText } from './text';

export class OcrError extends Error {}

export interface OcrResult {
  words: OcrWord[];
  text: string;
  confidence: number;
}

export interface OcrOptions {
  region?: Rect | null;
  onProgress?: (progress: number, status: string) => void;
  onEngineStatus?: (status: string) => void;
}

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

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
          user_defined_dpi: '150',
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

function upscaleCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new OcrError('This browser could not create a 2D canvas context.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function collectWords(blocks: unknown): Array<{ text: string; confidence: number; bbox: OcrWord['bbox'] }> {
  const output: Array<{ text: string; confidence: number; bbox: OcrWord['bbox'] }> = [];
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

/**
 * Runs Tesseract on a frame (or a normalized crop of it) and maps every word
 * box back into normalized 0..1 coordinates of the full frame.
 */
export async function recognizeCanvas(canvas: HTMLCanvasElement, options: OcrOptions = {}): Promise<OcrResult> {
  const region = options.region ?? null;
  const source = region ? cropNormalized(canvas, region) : canvas;

  const targetWidth = region ? 720 : 1400;
  const scale = Math.max(1, Math.min(3, targetWidth / Math.max(1, source.width)));
  const input = scale > 1.05 ? upscaleCanvas(source, scale) : source;
  const effectiveScale = input.width / Math.max(1, source.width);

  progressHandler = options.onProgress ?? null;
  engineStatusHandler = options.onEngineStatus ?? null;

  try {
    const worker = await getWorker();
    await worker.setParameters({
      tessedit_pageseg_mode: region ? PSM.SINGLE_BLOCK : PSM.SPARSE_TEXT,
    });
    const { data } = await worker.recognize(input, {}, { blocks: true, text: true });

    const offsetX = region ? region.x * canvas.width : 0;
    const offsetY = region ? region.y * canvas.height : 0;
    const clamp = (value: number) => Math.max(0, Math.min(1, value));

    const words: OcrWord[] = collectWords(data.blocks)
      .map((word) => {
        const x0 = clamp((offsetX + word.bbox.x0 / effectiveScale) / canvas.width);
        const y0 = clamp((offsetY + word.bbox.y0 / effectiveScale) / canvas.height);
        const x1 = clamp((offsetX + word.bbox.x1 / effectiveScale) / canvas.width);
        const y1 = clamp((offsetY + word.bbox.y1 / effectiveScale) / canvas.height);
        const normalized = normalizeText(word.text);
        return {
          text: word.text,
          normalized,
          confidence: Math.round(word.confidence * 10) / 10,
          bbox: { x0, y0, x1, y1 },
        };
      })
      .filter((word) => word.normalized.length > 0 && word.bbox.x1 > word.bbox.x0 && word.bbox.y1 > word.bbox.y0);

    return {
      words,
      text: typeof data.text === 'string' ? data.text.trim() : '',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    };
  } catch (error) {
    if (error instanceof OcrError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new OcrError(`OCR failed while reading a frame: ${detail}`);
  } finally {
    progressHandler = null;
    engineStatusHandler = null;
  }
}
