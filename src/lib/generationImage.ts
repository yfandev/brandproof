/**
 * Prepares the product photo for Comfy Cloud.
 *
 * The bundled LTX-2.3 workflow resizes the input image to a fixed 1920 × 1088
 * frame with a centred crop, so a portrait or square pack shot loses the top
 * and bottom of the label before the model ever sees it. BrandProof therefore
 * letterboxes the photo into that exact aspect ratio itself, on a softened
 * version of the same photo, so the workflow's own resize crops only the
 * padding.
 *
 * The verification reference stays the original, untouched photo.
 */

/** The frame the bundled workflow resizes to (ResizeImageMaskNode 1280 × 720). */
export const GENERATION_ASPECT = 16 / 9;
export const GENERATION_LONG_EDGE = 1920;

export interface FitBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixel size of the target frame for a source photo, capped at `longEdge`. */
export function frameSize(
  sourceWidth: number,
  sourceHeight: number,
  aspect: number = GENERATION_ASPECT,
  longEdge: number = GENERATION_LONG_EDGE,
): { width: number; height: number } {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new RangeError('The photo has no readable pixel dimensions.');
  }
  if (!(aspect > 0)) throw new RangeError('The frame aspect ratio must be positive.');

  const limit = Math.max(1, longEdge);
  let width = sourceWidth;
  let height = sourceHeight;
  if (width / height > aspect) {
    height = Math.round(width / aspect);
  } else {
    width = Math.round(height * aspect);
  }
  const scale = Math.min(1, limit / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Where the untouched photo is placed inside the padded frame. The returned
 * box never crops: the whole source photo is inside it, scaled to fit.
 */
export function fitBox(
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
): FitBox {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new RangeError('The photo has no readable pixel dimensions.');
  }
  if (!(frameWidth > 0) || !(frameHeight > 0)) {
    throw new RangeError('The target frame has no readable pixel dimensions.');
  }
  const scale = Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return {
    x: Math.round((frameWidth - width) / 2),
    y: Math.round((frameHeight - height) / 2),
    width,
    height,
  };
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through to the <img> decode path.
    }
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`"${file.name}" could not be decoded, so it cannot be prepared for the workflow.`);
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/**
 * Returns a padded JPEG at the workflow's aspect ratio. The full photo is
 * visible; the surrounding area is a blurred enlargement of the same photo, so
 * the model sees a continuous image instead of hard black bars.
 */
export async function prepareGenerationImage(file: File): Promise<File> {
  if (typeof document === 'undefined') return file;

  const decoded = await decodeImage(file);
  try {
    const frame = frameSize(decoded.width, decoded.height);
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not create a 2D canvas context.');

    // Cover the whole frame with a blurred enlargement of the photo.
    const coverScale = Math.max(frame.width / decoded.width, frame.height / decoded.height);
    const coverWidth = Math.max(1, Math.round(decoded.width * coverScale));
    const coverHeight = Math.max(1, Math.round(decoded.height * coverScale));
    try {
      context.filter = 'blur(26px)';
    } catch {
      // Older browsers ignore canvas filters; the fill is still valid.
    }
    context.drawImage(
      decoded.source,
      Math.round((frame.width - coverWidth) / 2),
      Math.round((frame.height - coverHeight) / 2),
      coverWidth,
      coverHeight,
    );
    context.filter = 'none';

    // Draw the whole, uncropped photo on top.
    const box = fitBox(decoded.width, decoded.height, frame.width, frame.height);
    context.drawImage(decoded.source, box.x, box.y, box.width, box.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.95);
    });
    if (!blob) throw new Error('The browser could not encode the prepared photo.');

    const base = file.name.replace(/\.[^.]+$/, '') || 'product';
    return new File([blob], `${base}-16x9.jpg`, { type: 'image/jpeg' });
  } finally {
    decoded.release();
  }
}
