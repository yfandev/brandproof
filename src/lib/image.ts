import type { Rect } from '../types';

export const IMAGE_MAX_DIMENSION = 1600;
const PALETTE_SAMPLE_WIDTH = 140;
const PALETTE_BINS = 4;

export class ImageLoadError extends Error {}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|avif|gif|bmp)$/i.test(file.name);
}

export function canvasFromImage(image: HTMLImageElement, maxDimension = IMAGE_MAX_DIMENSION): HTMLCanvasElement {
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new ImageLoadError('This browser could not create a 2D canvas context.');
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

export async function loadReferenceImage(file: File): Promise<{
  url: string;
  image: HTMLImageElement;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  paletteBins: number[];
  swatches: string[];
}> {
  if (!isImageFile(file)) {
    throw new ImageLoadError(
      `"${file.name}" is not a supported image. Use PNG, JPEG, WebP or AVIF.`,
    );
  }
  if (file.size > 25 * 1024 * 1024) {
    throw new ImageLoadError('That image is larger than 25 MB. Please compress it first.');
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;

  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageLoadError(
      `"${file.name}" could not be decoded. The file may be corrupt or in a format this browser cannot read.`,
    );
  }

  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new ImageLoadError('The image has no readable pixel dimensions.');
  }

  const canvas = canvasFromImage(image);
  const { bins, swatches } = paletteFromCanvas(canvas);
  return {
    url,
    image,
    canvas,
    width: image.naturalWidth,
    height: image.naturalHeight,
    paletteBins: bins,
    swatches,
  };
}

export function cropNormalized(canvas: HTMLCanvasElement, rect: Rect): HTMLCanvasElement {
  const x = Math.max(0, Math.min(1, rect.x));
  const y = Math.max(0, Math.min(1, rect.y));
  const w = Math.max(0.001, Math.min(1 - x, rect.w));
  const h = Math.max(0.001, Math.min(1 - y, rect.h));
  const sx = Math.round(x * canvas.width);
  const sy = Math.round(y * canvas.height);
  const sw = Math.max(1, Math.round(w * canvas.width));
  const sh = Math.max(1, Math.round(h * canvas.height));
  const output = document.createElement('canvas');
  output.width = sw;
  output.height = sh;
  const context = output.getContext('2d');
  if (!context) throw new ImageLoadError('This browser could not create a 2D canvas context.');
  context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return output;
}

function binIndex(r: number, g: number, b: number): number {
  const size = 256 / PALETTE_BINS;
  const rb = Math.min(PALETTE_BINS - 1, Math.floor(r / size));
  const gb = Math.min(PALETTE_BINS - 1, Math.floor(g / size));
  const bb = Math.min(PALETTE_BINS - 1, Math.floor(b / size));
  return (rb * PALETTE_BINS + gb) * PALETTE_BINS + bb;
}

export function paletteFromCanvas(canvas: HTMLCanvasElement): { bins: number[]; swatches: string[] } {
  const scale = Math.min(1, PALETTE_SAMPLE_WIDTH / Math.max(canvas.width, 1));
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const sample = document.createElement('canvas');
  sample.width = width;
  sample.height = height;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) throw new ImageLoadError('This browser could not create a 2D canvas context.');
  context.drawImage(canvas, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);

  const counts = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 32) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const index = binIndex(r, g, b);
    const entry = counts.get(index);
    if (entry) {
      entry.count += 1;
      entry.r += r;
      entry.g += g;
      entry.b += b;
    } else {
      counts.set(index, { count: 1, r, g, b });
    }
    total += 1;
  }

  const bins = new Array<number>(PALETTE_BINS ** 3).fill(0);
  for (const [index, entry] of counts) {
    bins[index] = entry.count / Math.max(1, total);
  }

  const swatches = Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((entry) => {
      const toHex = (value: number) =>
        Math.round(value / entry.count)
          .toString(16)
          .padStart(2, '0');
      return `#${toHex(entry.r)}${toHex(entry.g)}${toHex(entry.b)}`;
    });

  return { bins, swatches };
}

/** Histogram intersection in 0..1: a coarse colour-distribution overlap, not identity. */
export function comparePalettes(a: number[], b: number[]): number {
  let intersection = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    intersection += Math.min(a[i], b[i]);
  }
  return Math.max(0, Math.min(1, intersection));
}
