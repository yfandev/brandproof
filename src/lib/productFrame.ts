import type { Rect } from '../types';
import { clamp01 } from './preprocess';

/** Breathing room kept around the product when the photo is cropped to it. */
export const PRODUCT_MARGIN = 0.06;

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
 * backdrop colour and every pixel far enough from it counts towards the
 * product's bounding box. Returns null when nothing can be separated.
 */
export function subjectBoundsFromPixels({ data, width, height }: SubjectPixels): Rect | null {
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

/**
 * The crop rectangle that turns a wide pack shot into a product shot. Grows the
 * product box by a small margin so the cap and base are not clipped, and
 * declines when there is nothing worth cropping.
 */
export function cropRectForSubject(subject: Rect | null, margin = PRODUCT_MARGIN): Rect | null {
  if (!subject) return null;
  const area = subject.w * subject.h;
  // A sliver is backdrop noise; a box filling the photo would gain nothing.
  if (area < 0.04 || area > 0.9) return null;

  const padX = subject.w * margin;
  const padY = subject.h * margin;
  const x = clamp01(subject.x - padX);
  const y = clamp01(subject.y - padY);
  const right = clamp01(subject.x + subject.w + padX);
  const bottom = clamp01(subject.y + subject.h + padY);
  return { x, y, w: Math.max(0.02, right - x), h: Math.max(0.02, bottom - y) };
}

function contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser could not create a 2D canvas context.');
  return context;
}

/** Product bounds for a canvas, read from its pixels. */
export function subjectBounds(canvas: HTMLCanvasElement): Rect | null {
  try {
    const context = contextFor(canvas);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    return subjectBoundsFromPixels({ data, width, height });
  } catch {
    return null;
  }
}

/**
 * Crops a pack shot to the product itself, so the label occupies a larger share
 * of the frame the video model actually sees. This is the only honest way to put
 * more pixels behind the printed lines: prompts cannot add resolution.
 */
export function frameProductPhoto(canvas: HTMLCanvasElement): {
  canvas: HTMLCanvasElement;
  framed: boolean;
} {
  const crop = cropRectForSubject(subjectBounds(canvas));
  if (!crop) return { canvas, framed: false };

  const sx = Math.round(crop.x * canvas.width);
  const sy = Math.round(crop.y * canvas.height);
  const sw = Math.max(1, Math.round(crop.w * canvas.width));
  const sh = Math.max(1, Math.round(crop.h * canvas.height));

  const output = document.createElement('canvas');
  output.width = sw;
  output.height = sh;
  const context = contextFor(output);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return { canvas: output, framed: true };
}
