export interface CapturedFrame {
  index: number;
  time: number;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  dataUrl: string;
}

export class FrameCaptureError extends Error {}

const MAX_CAPTURE_WIDTH = 1920;
const SEEK_TIMEOUT_MS = 12000;

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      clearTimeout(timer);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onSeeked = () => finish();
    const onError = () =>
      finish(
        new FrameCaptureError(
          'The browser reported a media error while reading frames. Re-encode the clip as H.264 MP4 or WebM and try again.',
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new FrameCaptureError(
            `Seeking to ${time.toFixed(2)}s timed out. Some codecs cannot be scrubbed reliably in the browser.`,
          ),
        ),
      SEEK_TIMEOUT_MS,
    );

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);

    try {
      video.currentTime = time;
    } catch (error) {
      finish(error instanceof Error ? error : new FrameCaptureError('The video could not be seeked.'));
    }
  });
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new FrameCaptureError('Timed out waiting for video metadata.'));
    }, 10000);
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      clearTimeout(timer);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new FrameCaptureError('The browser could not decode this video file.'));
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

/** Evenly spaced sample times, inset from both edges to avoid fade/sting frames. */
export function sampleTimes(duration: number, count: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0.1) {
    throw new FrameCaptureError('This clip has no usable duration. Import a video longer than 0.2 seconds.');
  }
  const safeCount = Math.max(2, Math.floor(count));
  const start = duration * 0.04;
  const end = duration * 0.96;
  return Array.from({ length: safeCount }, (_, index) => {
    const ratio = safeCount === 1 ? 0.5 : index / (safeCount - 1);
    return Math.min(duration - 0.03, Math.max(0, start + (end - start) * ratio));
  });
}

export async function captureFrames(
  video: HTMLVideoElement,
  count: number,
  onProgress?: (done: number, total: number) => void,
): Promise<CapturedFrame[]> {
  await waitForMetadata(video);

  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    throw new FrameCaptureError(
      'The clip duration could not be read. Try a standard MP4 (H.264) or WebM file.',
    );
  }
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new FrameCaptureError('The clip has no decodable video track.');
  }

  if (!video.paused) video.pause();

  const times = sampleTimes(video.duration, count);
  const scale = Math.min(1, MAX_CAPTURE_WIDTH / video.videoWidth);
  const width = Math.max(2, Math.round(video.videoWidth * scale));
  const height = Math.max(2, Math.round(video.videoHeight * scale));

  const frames: CapturedFrame[] = [];
  for (let index = 0; index < times.length; index += 1) {
    await seek(video, times[index]);

    // Each frame needs its own canvas: the next draw must not overwrite evidence.
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new FrameCaptureError('This browser could not create a 2D canvas context.');
    context.drawImage(video, 0, 0, width, height);

    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    } catch {
      throw new FrameCaptureError(
        'Frames could not be read from this video because it is blocked by cross-origin restrictions. Import the file locally instead.',
      );
    }

    frames.push({
      index,
      time: Math.round(times[index] * 1000) / 1000,
      width,
      height,
      canvas,
      dataUrl,
    });
    onProgress?.(index + 1, times.length);
  }

  return frames;
}
