export class VideoProbeError extends Error {}

const SUPPORTED_EXTENSIONS = /\.(mp4|m4v|webm|ogv|ogg)$/i;

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|m4v|webm|ogv|ogg|mov)$/i.test(file.name);
}

export interface VideoProbe {
  duration: number;
  width: number;
  height: number;
}

function mediaErrorMessage(video: HTMLVideoElement, file: File): string {
  const code = video.error?.code;
  if (code === 4) {
    return `This browser cannot decode "${file.name}". Use MP4 (H.264) or WebM. MOV files from phones often use HEVC, which browsers do not play.`;
  }
  if (code === 3) {
    return `"${file.name}" is corrupt or partially downloaded (media decode error).`;
  }
  return `"${file.name}" could not be opened as video. Use an MP4 (H.264) or WebM file.`;
}

/**
 * Loads metadata for an object URL so we can reject undecodable clips before
 * they enter the workflow. The object URL itself stays owned by the caller.
 */
export function probeVideo(url: string, file: File, timeoutMs = 15000): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
    };
    const finish = (error?: Error, result?: VideoProbe) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish(
          new VideoProbeError(
            `Reading "${file.name}" timed out. The file may be too large or use an unsupported codec.`,
          ),
        ),
      timeoutMs,
    );

    video.addEventListener('loadedmetadata', () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!Number.isFinite(duration) || duration <= 0.1) {
        finish(
          new VideoProbeError(
            `"${file.name}" reports no usable duration (${Number.isNaN(duration) ? 'NaN' : duration.toFixed(2)}s). Try re-encoding it as MP4 H.264.`,
          ),
        );
        return;
      }
      if (!width || !height) {
        finish(new VideoProbeError(`"${file.name}" has no decodable video track.`));
        return;
      }
      finish(undefined, { duration, width, height });
    });

    video.addEventListener('error', () => {
      finish(new VideoProbeError(mediaErrorMessage(video, file)));
    });

    video.src = url;
    video.load();
  });
}

export function describeUnsupportedFile(file: File): string | null {
  if (file.type && !file.type.startsWith('video/') && !SUPPORTED_EXTENSIONS.test(file.name)) {
    return `"${file.name}" is not a video file. Import an MP4 (H.264), WebM or Ogg clip.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > 500 * 1024 * 1024) {
    return `"${file.name}" is larger than 500 MB. Trim or compress it before verifying.`;
  }
  return null;
}
