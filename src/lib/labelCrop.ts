import type { Rect } from '../types';
import { cropCanvasWithMeta, upscaleForOcr } from './preprocess';

/** The close-up is uploaded as the reference, so it only needs label detail. */
export const LABEL_CLOSE_UP_LONG_EDGE = 1400;

/**
 * Builds the reference image used for a label-retry attempt: the printed label
 * cropped out of the product photo and upscaled. A full product shot puts the
 * small print at roughly ten pixels in a 704p render, where the video model
 * turns it into plausible-looking pseudo-text. Handing it a label that fills the
 * reference is the only way the letters have enough pixels to survive.
 */
export async function labelCloseUpFile(
  canvas: HTMLCanvasElement,
  region: Rect | null,
  name: string,
): Promise<File | null> {
  if (!region) return null;
  const crop = cropCanvasWithMeta(canvas, region);
  const upscaled = upscaleForOcr(crop.canvas, LABEL_CLOSE_UP_LONG_EDGE);
  const blob = await new Promise<Blob | null>((resolve) => {
    upscaled.toBlob((value) => resolve(value), 'image/png');
  });
  if (!blob) return null;
  const safe = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'product';
  return new File([blob], `${safe}-label.png`, { type: 'image/png' });
}
