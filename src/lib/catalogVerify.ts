import type { VerificationReport } from '../types';
import { analyzeVideo, type AnalyzeProgress } from './analyze';
import { verificationConfigFor, type CatalogRunConfig } from './catalog';
import type { CatalogRuntimeProduct } from './catalogRunner';
import {
  formatBytes,
  isDefinitelyNotVideo,
  sniffVideoContainer,
  waitForVideoMetadata,
} from './video';

export interface VerifyClipInput {
  blob: Blob;
  filename: string;
  product: CatalogRuntimeProduct;
  brand: string;
  labelText: string;
  config: CatalogRunConfig;
  onProgress?: (progress: AnalyzeProgress) => void;
}

/**
 * Verifies a generated MP4 without showing it: the clip is loaded into an
 * off-screen <video>, sampled and OCR'd by the same analyzeVideo pipeline the
 * single-product studio uses, then the element and object URL are torn down.
 *
 * The container is sniffed first so a non-video body is reported as itself
 * instead of surfacing later as a vague codec timeout, and metadata is awaited
 * once (the analysis pipeline used to probe the same blob twice).
 */
export async function verifyGeneratedClip(input: VerifyClipInput): Promise<VerificationReport> {
  const { blob, filename } = input;
  if (!blob.size) throw new Error('Comfy returned an empty video file, so there is nothing to verify.');

  const container = sniffVideoContainer(new Uint8Array(await blob.slice(0, 12).arrayBuffer()));
  if (isDefinitelyNotVideo(container)) {
    throw new Error(
      `Comfy returned ${formatBytes(blob.size)} of ${container} instead of a video, so it cannot be verified. Download the clip again or regenerate it.`,
    );
  }

  const url = URL.createObjectURL(blob);
  const file = new File([blob], filename, {
    type: blob.type || 'video/mp4',
  });
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  // Off-screen rather than transparent: a fully transparent element may not be
  // composited, and drawing from it can stall.
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '0';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '1';
  video.style.pointerEvents = 'none';
  document.body.append(video);

  try {
    let probe;
    try {
      probe = await waitForVideoMetadata(video, file);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : 'The generated clip could not be read.'} (${
          formatBytes(blob.size)
        }, ${blob.type || 'unknown type'}, ${container} container.)`,
      );
    }

    return await analyzeVideo({
      video,
      config: verificationConfigFor({ brand: input.brand, labelText: input.labelText }, input.config),
      reference: input.product.reference,
      videoMeta: { name: filename, source: 'generated', duration: probe.duration },
      onProgress: input.onProgress,
    });
  } finally {
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // Best effort teardown.
    }
    video.remove();
    URL.revokeObjectURL(url);
  }
}
