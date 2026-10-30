import type { Bbox, OcrWord, Rect } from '../types';
import { clamp01, cropCanvasWithMeta, upscaleForOcr } from './preprocess';

/** LTX-2.3 renders around 1280 px wide, so there is no point sending more. */
export const RETRY_REFERENCE_LONG_EDGE = 1280;

export interface RegionPad {
  /** Fraction of the region's width added on the left and right. */
  x?: number;
  /** Fraction of the region's height added above and below. */
  top?: number;
  bottom?: number;
}

export function rectFromBbox(box: Bbox): Rect {
  const x = clamp01(Math.min(box.x0, box.x1));
  const y = clamp01(Math.min(box.y0, box.y1));
  const x1 = clamp01(Math.max(box.x0, box.x1));
  const y1 = clamp01(Math.max(box.y0, box.y1));
  return { x, y, w: Math.max(0.001, x1 - x), h: Math.max(0.001, y1 - y) };
}

export function regionArea(region: Rect): number {
  return Math.max(0, region.w) * Math.max(0, region.h);
}

/** Grows a region by fractions of its own size, clamped to the image. */
export function padRegion(region: Rect, pad: RegionPad = {}): Rect {
  const side = Math.max(0, pad.x ?? 0) * region.w;
  const above = Math.max(0, pad.top ?? pad.x ?? 0) * region.h;
  const below = Math.max(0, pad.bottom ?? pad.x ?? 0) * region.h;
  const x = clamp01(region.x - side);
  const y = clamp01(region.y - above);
  const right = clamp01(region.x + region.w + side);
  const bottom = clamp01(region.y + region.h + below);
  return { x, y, w: Math.max(0.001, right - x), h: Math.max(0.001, bottom - y) };
}

export function unionRegion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0.001, right - x), h: Math.max(0.001, bottom - y) };
}

/** True when the centre of `inner` falls inside `outer`. */
export function containsRegion(outer: Rect, inner: Rect): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

/** Every detected word box, unioned. Null when nothing was read off the photo. */
export function textBlockRegion(words: Array<Pick<OcrWord, 'bbox'>>): Rect | null {
  const boxes = words.filter(
    (word) =>
      word?.bbox &&
      Number.isFinite(word.bbox.x0) &&
      Number.isFinite(word.bbox.y0) &&
      word.bbox.x1 > word.bbox.x0 &&
      word.bbox.y1 > word.bbox.y0,
  );
  if (boxes.length === 0) return null;

  const union = boxes.reduce<Bbox>(
    (accumulator, { bbox }) => ({
      x0: Math.min(accumulator.x0, bbox.x0),
      y0: Math.min(accumulator.y0, bbox.y0),
      x1: Math.max(accumulator.x1, bbox.x1),
      y1: Math.max(accumulator.y1, bbox.y1),
    }),
    { x0: 1, y0: 1, x1: 0, y1: 0 },
  );
  return rectFromBbox(union);
}

export interface RetryRegionInput {
  /** Union of the text boxes read off the reference photo. */
  text: Rect | null;
  /** Bounding box of the product itself, when it could be separated from the backdrop. */
  subject: Rect | null;
}

/**
 * Picks the region used as the reference image for a retry attempt.
 *
 * An earlier version cropped just the printed label. That gave the wording
 * enough pixels but replaced the bottle with a flat label, so the rendered clip
 * lost the product. Cropping the whole package instead keeps the shape on screen
 * while still enlarging the label far beyond its size in the original framing.
 */
export function retryReferenceRegion({ text, subject }: RetryRegionInput): Rect | null {
  const subjectArea = subject ? regionArea(subject) : 0;

  // A subject that fills the photo already got no benefit from cropping, and a
  // sliver is more likely backdrop noise than packaging.
  if (subject && subjectArea >= 0.12 && subjectArea <= 0.72) {
    const pad: RegionPad = { x: 0.06, top: 0.05, bottom: 0.05 };
    const crop = padRegion(subject, pad);
    if (!text || containsRegion(crop, text)) return crop;
    // Never crop the required wording out of the reference.
    return padRegion(unionRegion(subject, text), pad);
  }

  if (text) {
    const crop = padRegion(text, { x: 0.24, top: 0.5, bottom: 0.62 });
    // A crop that is basically the whole photo is not a closer framing.
    if (regionArea(crop) <= 0.9) return crop;
  }

  return null;
}

export interface SubjectPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 128;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Separates the product from a studio backdrop: the border ring gives the
 * backdrop colour, and every pixel far enough from it counts towards the
 * subject's bounding box. Returns null when no subject can be separated.
 */
export function subjectRegionFromPixels({ data, width, height }: SubjectPixels): Rect | null {
  if (width < 8 || height < 8 || data.length < width * height * 4) return null;

  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const stepX = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 80));
  const sample = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    reds.push(data[index]);
    greens.push(data[index + 1]);
    blues.push(data[index + 2]);
  };
  for (let x = 0; x < width; x += stepX) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += stepY) {
    sample(0, y);
    sample(width - 1, y);
  }

  const backdrop = [median(reds), median(greens), median(blues)];
  const threshold = 38;
  const columnHits = new Int32Array(width);
  const rowHits = new Int32Array(height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const delta = Math.max(
        Math.abs(data[index] - backdrop[0]),
        Math.abs(data[index + 1] - backdrop[1]),
        Math.abs(data[index + 2] - backdrop[2]),
      );
      if (delta <= threshold) continue;
      columnHits[x] += 1;
      rowHits[y] += 1;
    }
  }

  // Ignore isolated specks: a column or row only counts if a visible share of it
  // differs from the backdrop.
  const columnMin = Math.max(2, Math.round(height * 0.02));
  const rowMin = Math.max(2, Math.round(width * 0.02));
  let x0 = -1;
  let x1 = -1;
  let y0 = -1;
  let y1 = -1;
  for (let x = 0; x < width; x += 1) {
    if (columnHits[x] < columnMin) continue;
    if (x0 < 0) x0 = x;
    x1 = x;
  }
  for (let y = 0; y < height; y += 1) {
    if (rowHits[y] < rowMin) continue;
    if (y0 < 0) y0 = y;
    y1 = y;
  }
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) return null;

  return {
    x: x0 / width,
    y: y0 / height,
    w: (x1 - x0 + 1) / width,
    h: (y1 - y0 + 1) / height,
  };
}

/** Reads the canvas once to locate the product against its backdrop. */
export function subjectRegion(canvas: HTMLCanvasElement): Rect | null {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    return subjectRegionFromPixels({ data, width, height });
  } catch {
    return null;
  }
}

function contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser could not create a 2D canvas context.');
  return context;
}

/**
 * Crops the retry region out of the product photo and upscales it. The full-size
 * photo leaves the fine print at roughly ten pixels in a 704p render, where the
 * model turns it into plausible-looking pseudo-text; a closer framing of the same
 * package is the only input change that gives those letters real pixels.
 */
export async function retryReferenceFile(
  canvas: HTMLCanvasElement,
  region: Rect | null,
  name: string,
): Promise<File | null> {
  if (!region) return null;
  const crop = cropCanvasWithMeta(canvas, region);
  const upscaled = upscaleForOcr(crop.canvas, RETRY_REFERENCE_LONG_EDGE);
  const blob = await new Promise<Blob | null>((resolve) => {
    upscaled.toBlob((value) => resolve(value), 'image/png');
  });
  if (!blob) return null;

  // Re-draw through a fresh canvas so the PNG never carries a stale backing store.
  const output = document.createElement('canvas');
  output.width = upscaled.width;
  output.height = upscaled.height;
  contextFor(output).drawImage(upscaled, 0, 0);

  const safe = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'product';
  const finalBlob = await new Promise<Blob | null>((resolve) => {
    output.toBlob((value) => resolve(value), 'image/png');
  });
  if (!finalBlob) return null;
  return new File([finalBlob], `${safe}-product.png`, { type: 'image/png' });
}
