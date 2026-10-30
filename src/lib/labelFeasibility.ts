import type { OcrWord } from '../types';

/** Height of the generated clip the bundled LTX-2.3 workflow produces. */
export const RENDER_HEIGHT_PX = 720;

/**
 * Roughly where diffusion video models stop reproducing letters and start
 * painting plausible-looking text. Below this the render invents lettering,
 * which is exactly what the verification then has to catch.
 */
export const MIN_RENDER_TEXT_PX = 24;

export type LabelFeasibilityStatus = 'ok' | 'marginal' | 'hopeless';

export interface LabelFeasibility {
  /** Median printed-line height in the uploaded photo, in pixels. */
  photoPx: number;
  /** Where that line lands in the generated frame, in pixels. */
  renderPx: number;
  status: LabelFeasibilityStatus;
  message: string;
}

/** Median word-box height, which is a good stand-in for one printed line. */
export function medianLineHeightPx(
  words: Array<Pick<OcrWord, 'bbox'>>,
  photoHeightPx: number,
): number | null {
  const heights = words
    .map((word) => (word.bbox.y1 - word.bbox.y0) * photoHeightPx)
    .filter((height) => Number.isFinite(height) && height >= 2)
    .sort((a, b) => a - b);
  if (heights.length === 0) return null;
  return Math.round(heights[Math.floor(heights.length / 2)]);
}

/**
 * Turns a measured line height into a plain statement about whether the video
 * model can reproduce it. This exists so the app stops promising a pass the
 * source photo cannot support: a label printed 11 px tall in the photo lands at
 * roughly 7 px in a 720p render, where the model paints pseudo-text instead.
 */
export function labelFeasibility(
  photoPx: number | null,
  options: { photoHeightPx?: number; renderHeightPx?: number } = {},
): LabelFeasibility | null {
  if (photoPx === null || !Number.isFinite(photoPx) || photoPx <= 0) return null;
  const renderHeightPx = options.renderHeightPx ?? RENDER_HEIGHT_PX;
  const photoHeightPx = options.photoHeightPx ?? 0;
  // The photo is fitted into the 16:9 render frame, so scale by height when the
  // frame is closer to the source, otherwise by the shorter edge.
  const scale =
    photoHeightPx > 0
      ? Math.min(1, renderHeightPx / photoHeightPx)
      : Math.min(1, renderHeightPx / Math.max(1, photoPx * 60));
  const renderPx = Math.max(1, Math.round(photoPx * scale));

  if (renderPx >= MIN_RENDER_TEXT_PX * 1.7) {
    return {
      photoPx,
      renderPx,
      status: 'ok',
      message: `Printed lines measure about ${photoPx} px in this photo, roughly ${renderPx} px in a ${renderHeightPx}p clip — enough for the model to reproduce them.`,
    };
  }
  if (renderPx >= MIN_RENDER_TEXT_PX) {
    return {
      photoPx,
      renderPx,
      status: 'marginal',
      message: `Printed lines measure about ${photoPx} px in this photo, roughly ${renderPx} px in a ${renderHeightPx}p clip. That is near the legibility floor: a retry uses a closer framing of the same package to buy pixels.`,
    };
  }
  return {
    photoPx,
    renderPx,
    status: 'hopeless',
    message: `Printed lines measure about ${photoPx} px in this photo, roughly ${renderPx} px in a ${renderHeightPx}p clip — below the ~${MIN_RENDER_TEXT_PX} px where a video model starts reproducing letters, so it will paint plausible-looking text instead. Retries change only the prompt, so the render is expected to invent this lettering; a photo where the label fills more of the frame is the only way to make this check passable.`,
  };
}
