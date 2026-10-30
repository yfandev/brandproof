import type { Bbox, OcrWord, Rect } from '../types';
import { clamp01, cropCanvasWithMeta, upscaleForOcr } from './preprocess';

/** Matches what the bundled LTX-2.3 workflow receives after its 16:9 fit. */
export const LABEL_REFERENCE_LONG_EDGE = 1280;

/**
 * A printed line should occupy at least this share of the reference height, so
 * it lands above the ~24 px floor where diffusion video models stop drawing
 * letters. 4.5% of 720 px is ~32 px.
 */
export const MIN_LABEL_LINE_FRACTION = 0.045;

export interface LabelOverlayLine {
  text: string;
  /** Box of this line in normalized source-photo coordinates. */
  box: Bbox;
}

export interface PlacedLabelLine {
  text: string;
  /** Centre of the line in reference-canvas pixels. */
  x: number;
  y: number;
  /** Font size in reference-canvas pixels. */
  size: number;
  /** Width the line is drawn into, used for the background patch. */
  width: number;
}

interface Clustered {
  box: Bbox;
  words: Array<{ text: string; box: Bbox }>;
}

/**
 * Groups OCR words into printed lines by vertical overlap, then joins each line
 * left to right. Only what was actually read off the photo is used — nothing is
 * taken from the expected text.
 */
export function labelOverlayLines(words: OcrWord[]): LabelOverlayLine[] {
  const usable = words
    .filter((word) => word.text.replace(/[^A-Za-z0-9]/g, '').length >= 2)
    .map((word) => ({ text: word.text.trim(), box: word.bbox }))
    .filter((word) => word.text.length > 0);
  if (usable.length === 0) return [];

  const clusters: Clustered[] = [];
  for (const word of [...usable].sort((a, b) => a.box.y0 - b.box.y0)) {
    const centre = (word.box.y0 + word.box.y1) / 2;
    const height = Math.max(0.0001, word.box.y1 - word.box.y0);
    const match = clusters.find((cluster) => {
      const clusterCentre = (cluster.box.y0 + cluster.box.y1) / 2;
      const clusterHeight = Math.max(0.0001, cluster.box.y1 - cluster.box.y0);
      return Math.abs(clusterCentre - centre) <= Math.min(height, clusterHeight) * 0.6;
    });
    if (!match) {
      clusters.push({ box: { ...word.box }, words: [word] });
      continue;
    }
    match.words.push(word);
    match.box = {
      x0: Math.min(match.box.x0, word.box.x0),
      y0: Math.min(match.box.y0, word.box.y0),
      x1: Math.max(match.box.x1, word.box.x1),
      y1: Math.max(match.box.y1, word.box.y1),
    };
  }

  return clusters
    .map((cluster) => ({
      text: cluster.words
        .sort((a, b) => a.box.x0 - b.box.x0)
        .map((word) => word.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      box: cluster.box,
    }))
    .filter((line) => line.text.length > 0)
    .sort((a, b) => a.box.y0 - b.box.y0);
}

function mapAxis(value: number, start: number, span: number): number {
  return span > 0 ? (value - start) / span : 0;
}

/**
 * Places each read line on the reference canvas at its real position, with a
 * font size large enough to survive the render. Pure geometry, so the minimum
 * size rule and clamping are testable without a canvas.
 */
export function layoutLabelLines(
  lines: LabelOverlayLine[],
  crop: Rect,
  output: { width: number; height: number },
): PlacedLabelLine[] {
  if (lines.length === 0 || output.width <= 0 || output.height <= 0) return [];
  const minSize = Math.max(12, output.height * MIN_LABEL_LINE_FRACTION);
  const maxSize = output.height * 0.16;

  return lines
    .map((line) => {
      const left = clamp01(mapAxis(line.box.x0, crop.x, crop.w)) * output.width;
      const right = clamp01(mapAxis(line.box.x1, crop.x, crop.w)) * output.width;
      const top = clamp01(mapAxis(line.box.y0, crop.y, crop.h)) * output.height;
      const bottom = clamp01(mapAxis(line.box.y1, crop.y, crop.h)) * output.height;
      const measured = Math.max(1, bottom - top);
      return {
        text: line.text,
        x: (left + right) / 2,
        y: (top + bottom) / 2,
        size: Math.min(maxSize, Math.max(minSize, measured)),
        width: Math.max(measured, right - left),
      };
    })
    .sort((a, b) => a.y - b.y);
}

function contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser could not create a 2D canvas context.');
  return context;
}

function patchColour(
  source: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
): { fill: string; ink: string } {
  const context = contextFor(source);
  const x = Math.max(0, Math.min(source.width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(source.height - 1, Math.round(rect.y)));
  const w = Math.max(1, Math.min(source.width - x, Math.round(rect.w)));
  const h = Math.max(1, Math.min(source.height - y, Math.round(rect.h)));
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(x, y, w, h).data;
  } catch {
    return { fill: '#efeae1', ink: '#1b1a17' };
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 16) {
    r += data[index];
    g += data[index + 1];
    b += data[index + 2];
    count += 1;
  }
  if (count === 0) return { fill: '#efeae1', ink: '#1b1a17' };
  r = Math.round(r / count);
  g = Math.round(g / count);
  b = Math.round(b / count);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return {
    fill: `rgb(${r}, ${g}, ${b})`,
    // Dark ink on a light label, light ink on a dark one, so the drawn line has
    // contrast regardless of the packaging colour.
    ink: luminance > 130 ? '#141310' : '#f7f4ee',
  };
}

/**
 * Builds the retry reference: the same product, cropped to the package, with the
 * label re-drawn from the lines OCR actually read in the photo. The bottle stays
 * in frame — the failure mode of a label-only crop — while the lettering is
 * drawn sharply at a size the video model can reproduce instead of being guessed
 * from ten-pixel source pixels.
 */
export async function labelReferenceFile(
  canvas: HTMLCanvasElement,
  region: Rect,
  lines: LabelOverlayLine[],
  name: string,
): Promise<File | null> {
  if (lines.length === 0) return null;

  const crop = cropCanvasWithMeta(canvas, region);
  const base = upscaleForOcr(crop.canvas, LABEL_REFERENCE_LONG_EDGE);
  const output = document.createElement('canvas');
  output.width = base.width;
  output.height = base.height;
  const context = contextFor(output);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(base, 0, 0);

  const placed = layoutLabelLines(lines, region, { width: output.width, height: output.height });
  for (const line of placed) {
    const patch = patchColour(output, {
      x: line.x - line.width / 2,
      y: line.y - line.size * 0.85,
      w: line.width,
      h: line.size * 1.7,
    });

    // Cover the blurry source lettering that this line replaces, then draw the
    // read text sharply over it.
    context.fillStyle = patch.fill;
    context.fillRect(
      line.x - line.width / 2 - line.size * 0.4,
      line.y - line.size * 0.85,
      line.width + line.size * 0.8,
      line.size * 1.7,
    );

    context.fillStyle = patch.ink;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `600 ${Math.round(line.size)}px Inter, "Helvetica Neue", Arial, sans-serif`;
    const fitted = Math.max(0.5, Math.min(1, line.width / Math.max(1, context.measureText(line.text).width)));
    if (fitted < 1) {
      context.font = `600 ${Math.round(line.size * fitted)}px Inter, "Helvetica Neue", Arial, sans-serif`;
    }
    context.fillText(line.text, line.x, line.y);
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    output.toBlob((value) => resolve(value), 'image/png');
  });
  if (!blob) return null;
  const safe = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'product';
  return new File([blob], `${safe}-label-read.png`, { type: 'image/png' });
}
