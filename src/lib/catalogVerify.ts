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
  /** Same-origin route that streams the same bytes, used when the blob stalls. */
  sourceUrl?: string | null;
  onProgress?: (progress: AnalyzeProgress) => void;
}

interface LoadedClip {
  video: HTMLVideoElement;
  label: string;
  duration: number;
}

/** A detached element, which is the same shape the Studio probe uses. */
function createElement(src: string): HTMLVideoElement {
  const video = document.createElement('video');
  video.src = src;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  video.load();
  return video;
}

async function loadClip(
  src: string,
  label: string,
  file: File,
  timeoutMs: number,
): Promise<LoadedClip> {
  const video = createElement(src);
  try {
    const probe = await waitForVideoMetadata(video, file, timeoutMs);
    return { video, label, duration: probe.duration };
  } catch (error) {
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // Best-effort teardown.
    }
    throw error;
  }
}

/**
 * Verifies a generated MP4 without showing it: the clip is loaded into an
 * off-screen <video>, sampled and OCR'd by the same analyzeVideo pipeline the
 * single-product studio uses, then torn down.
 *
 * Media loading is layered rather than a single bet: the in-memory blob first,
 * then (when the caller supplies it) the same-origin Worker route that streams
 * the identical bytes. A blob queued behind other downloads can sit at
 * readyState 0, and a network source loads independently of that, so the second
 * path recovers a clip that is perfectly decodable. Both failures are reported
 * together instead of collapsing into one vague timeout.
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
  const file = new File([blob], filename, { type: blob.type || 'video/mp4' });

  const sources: Array<{ src: string; label: string; timeoutMs: number }> = [
    { src: url, label: 'in-memory clip', timeoutMs: 30000 },
  ];
  if (input.sourceUrl) {
    sources.push({ src: input.sourceUrl, label: 'Comfy stream', timeoutMs: 60000 });
  }

  let loaded: LoadedClip | null = null;
  const failures: string[] = [];
  for (const source of sources) {
    try {
      loaded = await loadClip(source.src, source.label, file, source.timeoutMs);
      break;
    } catch (error) {
      failures.push(`${source.label}: ${error instanceof Error ? error.message : 'unreadable'}`);
    }
  }

  if (!loaded) {
    URL.revokeObjectURL(url);
    throw new Error(
      `The generated clip could not be opened for verification (${formatBytes(blob.size)}, ${
        blob.type || 'unknown type'
      }, ${container} container). ${failures.join(' — ')}`,
    );
  }

  const { video, duration } = loaded;
  // Attach before sampling: drawImage needs the element in the document to have
  // a composited frame. It stays off-screen and out of hit-testing.
  Object.assign(video.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
    width: '320px',
    height: '180px',
    opacity: '0.01',
    pointerEvents: 'none',
  });
  document.body.append(video);

  try {
    return await analyzeVideo({
      video,
      config: verificationConfigFor({ brand: input.brand, labelText: input.labelText }, input.config),
      reference: input.product.reference,
      videoMeta: { name: filename, source: 'generated', duration },
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
