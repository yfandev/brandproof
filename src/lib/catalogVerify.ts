import type { VerificationReport } from '../types';
import { analyzeVideo, type AnalyzeProgress } from './analyze';
import { verificationConfigFor, type CatalogRunConfig } from './catalog';
import type { CatalogRuntimeProduct } from './catalogRunner';
import { probeVideo } from './video';

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
 * Verifies a generated MP4 without showing it: the clip is loaded into a hidden
 * <video>, sampled and OCR'd by the same analyzeVideo pipeline the single-product
 * studio uses, then the element and object URL are torn down.
 */
export async function verifyGeneratedClip(input: VerifyClipInput): Promise<VerificationReport> {
  const url = URL.createObjectURL(input.blob);
  const file = new File([input.blob], input.filename, {
    type: input.blob.type || 'video/mp4',
  });
  let video: HTMLVideoElement | null = null;

  try {
    const probe = await probeVideo(url, file);

    video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    video.style.width = '2px';
    video.style.height = '2px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.append(video);

    await new Promise<void>((resolve, reject) => {
      const element = video as HTMLVideoElement;
      if (element.readyState >= 1) {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => {
        reject(new Error('The generated clip did not become readable in time.'));
      }, 15000);
      element.addEventListener(
        'loadedmetadata',
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      element.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer);
          reject(new Error('The browser could not decode the generated clip.'));
        },
        { once: true },
      );
    });

    return await analyzeVideo({
      video,
      config: verificationConfigFor({ brand: input.brand, labelText: input.labelText }, input.config),
      reference: input.product.reference,
      videoMeta: { name: input.filename, source: 'generated', duration: probe.duration },
      onProgress: input.onProgress,
    });
  } finally {
    if (video) {
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // Best effort teardown.
      }
      video.remove();
    }
    URL.revokeObjectURL(url);
  }
}
