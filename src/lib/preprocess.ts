import type { Bbox, OcrWord, Rect } from '../types';

export type PreprocessVariant = 'original' | 'grayscale' | 'contrast' | 'threshold' | 'threshold-inverted';

export const OCR_FULL_FRAME_LONG_EDGE = 2200;
export const OCR_CROP_LONG_EDGE = 1800;
export const OCR_MAX_SCALE = 6;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Rec. 709 luminance, returned as an RGBA buffer with alpha preserved. */
export function grayscalePixels(data: Uint8ClampedArray): Uint8ClampedArray {
  const output = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const value = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    output[i] = value;
    output[i + 1] = value;
    output[i + 2] = value;
    output[i + 3] = data[i + 3];
  }
  return output;
}

/** Expands values around mid-grey. Amount 1 is a no-op; 1.6 is a useful label boost. */
export function contrastPixels(data: Uint8ClampedArray, amount = 1.6): Uint8ClampedArray {
  const factor = Math.max(0, amount);
  const output = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    output[i] = (data[i] - 128) * factor + 128;
    output[i + 1] = (data[i + 1] - 128) * factor + 128;
    output[i + 2] = (data[i + 2] - 128) * factor + 128;
    output[i + 3] = data[i + 3];
  }
  return output;
}

function luminanceAt(data: Uint8ClampedArray, index: number): number {
  return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}

/**
 * Adaptive mean threshold using an integral image. This keeps faint small text
 * on uneven packaging backgrounds from disappearing under one global threshold.
 */
export function adaptiveThresholdPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  blockSize = 15,
  constant = 8,
  invert = false,
): Uint8ClampedArray {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    throw new Error('Adaptive threshold received invalid pixel dimensions.');
  }

  const radius = Math.max(1, Math.floor(Math.max(3, blockSize) / 2));
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      const luminance = luminanceAt(data, (y * width + x) * 4);
      rowSum += invert ? 255 - luminance : luminance;
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
    }
  }

  const output = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha < 16) {
        output[index] = data[index];
        output[index + 1] = data[index + 1];
        output[index + 2] = data[index + 2];
        output[index + 3] = alpha;
        continue;
      }

      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum =
        integral[(y1 + 1) * stride + (x1 + 1)] -
        integral[y0 * stride + (x1 + 1)] -
        integral[(y1 + 1) * stride + x0] +
        integral[y0 * stride + x0];
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = sum / count;
      const luminance = luminanceAt(data, index);
      // Inverting the input turns light-on-dark text into dark-on-light text,
      // which Tesseract handles far better than an inverted binary output.
      const lit = (invert ? 255 - luminance : luminance) > mean - constant;
      const value = lit ? 255 : 0;
      output[index] = value;
      output[index + 1] = value;
      output[index + 2] = value;
      output[index + 3] = alpha;
    }
  }

  return output;
}

function contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser could not create a 2D canvas context.');
  return context;
}

export function canvasFromPixels(data: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = contextFor(canvas);
  const image = context.createImageData(width, height);
  image.data.set(data);
  context.putImageData(image, 0, 0);
  return canvas;
}

export function upscaleCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  if (!Number.isFinite(scale) || scale <= 1.02) return source;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = contextFor(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Upscales with a cap, preserving the aspect ratio. */
export function upscaleForOcr(source: HTMLCanvasElement, targetLongEdge: number, maxScale = OCR_MAX_SCALE): HTMLCanvasElement {
  const longEdge = Math.max(source.width, source.height, 1);
  const scale = Math.max(1, Math.min(maxScale, targetLongEdge / longEdge));
  return upscaleCanvas(source, scale);
}

export function preprocessCanvas(source: HTMLCanvasElement, variant: PreprocessVariant): HTMLCanvasElement {
  if (variant === 'original') return source;

  const context = contextFor(source);
  const image = context.getImageData(0, 0, source.width, source.height);
  const gray = grayscalePixels(image.data);
  let pixels: Uint8ClampedArray;

  switch (variant) {
    case 'grayscale':
      pixels = gray;
      break;
    case 'contrast':
      pixels = contrastPixels(gray, 1.65);
      break;
    case 'threshold':
      pixels = adaptiveThresholdPixels(gray, source.width, source.height, 15, 8, false);
      break;
    case 'threshold-inverted':
      pixels = adaptiveThresholdPixels(gray, source.width, source.height, 15, 8, true);
      break;
    default:
      pixels = image.data;
  }

  return canvasFromPixels(pixels, source.width, source.height);
}

export interface CropMeta {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function cropCanvasWithMeta(
  canvas: HTMLCanvasElement,
  rect: Rect,
): { canvas: HTMLCanvasElement; crop: CropMeta } {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  const w = Math.max(0.001, Math.min(1 - x, rect.w));
  const h = Math.max(0.001, Math.min(1 - y, rect.h));
  const sx = Math.max(0, Math.min(canvas.width - 1, Math.round(x * canvas.width)));
  const sy = Math.max(0, Math.min(canvas.height - 1, Math.round(y * canvas.height)));
  const sw = Math.max(1, Math.min(canvas.width - sx, Math.round(w * canvas.width)));
  const sh = Math.max(1, Math.min(canvas.height - sy, Math.round(h * canvas.height)));

  const output = document.createElement('canvas');
  output.width = sw;
  output.height = sh;
  contextFor(output).drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return { canvas: output, crop: { x: sx, y: sy, w: sw, h: sh } };
}

export interface CropTransform {
  frameWidth: number;
  frameHeight: number;
  cropX: number;
  cropY: number;
  /** OCR-input pixels per source-crop pixel. */
  scale: number;
}

/** Maps a word box from an OCR input canvas back to normalized full-frame coordinates. */
export function mapBboxToFrame(bbox: Bbox, transform: CropTransform): Bbox {
  const scale = transform.scale > 0 ? transform.scale : 1;
  const mapX = (value: number) => clamp01((transform.cropX + value / scale) / Math.max(1, transform.frameWidth));
  const mapY = (value: number) => clamp01((transform.cropY + value / scale) / Math.max(1, transform.frameHeight));
  return {
    x0: mapX(bbox.x0),
    y0: mapY(bbox.y0),
    x1: mapX(bbox.x1),
    y1: mapY(bbox.y1),
  };
}

export function bboxIoU(a: Bbox, b: Bbox): number {
  const width = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const height = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const intersection = width * height;
  const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function centersClose(a: Bbox, b: Bbox): boolean {
  const aw = a.x1 - a.x0;
  const ah = a.y1 - a.y0;
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  const dx = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
  const dy = Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  return dx <= Math.max(aw, bw) * 0.35 && dy <= Math.max(ah, bh) * 0.5;
}

/**
 * Combines words from several OCR passes. Same text in the same place keeps the
 * highest-confidence reading and its real box; distinct instances stay separate.
 */
export function mergeOcrWords(words: OcrWord[]): OcrWord[] {
  const ordered = [...words].sort((a, b) => b.confidence - a.confidence);
  const kept: OcrWord[] = [];

  for (const word of ordered) {
    if (!word.normalized) continue;
    const duplicate = kept.find(
      (existing) =>
        existing.normalized === word.normalized &&
        (bboxIoU(existing.bbox, word.bbox) >= 0.45 || centersClose(existing.bbox, word.bbox)),
    );
    if (!duplicate) kept.push({ ...word });
  }

  return kept.sort(
    (a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0 || a.bbox.y1 - b.bbox.y1,
  );
}

/**
 * Expands the brand word into a generous label neighborhood. If the brand fills
 * most of the frame the region is rejected, because a crop would add no detail.
 */
/**
 * A printed label is a stack of lines centred on the same axis. A crop anchored
 * on the brand word alone cuts off the smaller lines above and below it, so they
 * were never read at crop resolution. Union the anchor with the same-column
 * words within a few line-heights so one crop covers the whole label block.
 */
export function labelBlockBbox(anchor: Bbox, blocks: Bbox[], maxGapRatio = 6): Bbox {
  const width = anchor.x1 - anchor.x0;
  const height = Math.max(1e-6, anchor.y1 - anchor.y0);
  if (width <= 0) return { ...anchor };

  const centerX = (anchor.x0 + anchor.x1) / 2;
  const tolerance = Math.max(0.05, width) / 2 + Math.max(0.02, width * 0.35);
  let box: Bbox = { ...anchor };

  for (const block of blocks) {
    const blockWidth = block.x1 - block.x0;
    const blockHeight = block.y1 - block.y0;
    if (blockWidth <= 0 || blockHeight <= 0 || blockHeight > height * 1.8) continue;
    const blockCenter = (block.x0 + block.x1) / 2;
    const gap =
      block.y1 < anchor.y0
        ? anchor.y0 - block.y1
        : block.y0 > anchor.y1
          ? block.y0 - anchor.y1
          : 0;
    if (Math.abs(blockCenter - centerX) > tolerance || gap > height * maxGapRatio) continue;
    box = {
      x0: Math.min(box.x0, block.x0),
      y0: Math.min(box.y0, block.y0),
      x1: Math.max(box.x1, block.x1),
      y1: Math.max(box.y1, block.y1),
    };
  }

  return box;
}

export function deriveLabelRegion(anchor: Bbox): Rect | null {
  const width = anchor.x1 - anchor.x0;
  const height = anchor.y1 - anchor.y0;
  if (width <= 0 || height <= 0) return null;

  const padX = Math.max(0.03, width * 0.9);
  const padY = Math.max(0.045, height * 2.6);
  const x = clamp01(anchor.x0 - padX);
  const y = clamp01(anchor.y0 - padY);
  const x1 = clamp01(anchor.x1 + padX);
  const y1 = clamp01(anchor.y1 + padY);
  const rect = { x, y, w: x1 - x, h: y1 - y };

  if (rect.w < 0.08 || rect.h < 0.08) return null;
  if (rect.w * rect.h > 0.9) return null;
  return rect;
}

/**
 * Fallback auto-crop when no expected brand anchor was read: choose the densest
 * horizontal text cluster and expand it slightly. It is a heuristic, not object
 * detection, and is labelled as automatic in the report.
 */
export function densestTextRegion(words: OcrWord[]): Rect | null {
  const usable = words
    .filter((word) => word.normalized.length >= 2 && word.confidence >= 25)
    .slice(0, 120);
  if (usable.length < 2) return null;

  let best: OcrWord[] = [];
  let bestScore = 0;
  for (const seed of usable) {
    const seedHeight = seed.bbox.y1 - seed.bbox.y0;
    const seedCenterY = (seed.bbox.y0 + seed.bbox.y1) / 2;
    const seedCenterX = (seed.bbox.x0 + seed.bbox.x1) / 2;
    const cluster = usable.filter((word) => {
      const height = word.bbox.y1 - word.bbox.y0;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
      return (
        Math.abs(centerY - seedCenterY) <= Math.max(seedHeight, height) * 2.2 &&
        Math.abs(centerX - seedCenterX) <= 0.3
      );
    });
    const score = cluster.reduce((total, word) => total + word.normalized.length, 0);
    if (score > bestScore) {
      best = cluster;
      bestScore = score;
    }
  }

  if (best.length < 2) return null;
  const x0 = Math.min(...best.map((word) => word.bbox.x0));
  const y0 = Math.min(...best.map((word) => word.bbox.y0));
  const x1 = Math.max(...best.map((word) => word.bbox.x1));
  const y1 = Math.max(...best.map((word) => word.bbox.y1));
  const padX = Math.max(0.03, (x1 - x0) * 0.35);
  const padY = Math.max(0.04, (y1 - y0) * 0.5);
  const rect = {
    x: clamp01(x0 - padX),
    y: clamp01(y0 - padY),
    w: clamp01(x1 + padX) - clamp01(x0 - padX),
    h: clamp01(y1 + padY) - clamp01(y0 - padY),
  };
  if (rect.w < 0.1 || rect.h < 0.06 || rect.w * rect.h > 0.8) return null;
  return rect;
}
