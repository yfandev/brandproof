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

/** What the first bytes of a downloaded file actually look like. */
export type VideoContainer =
  | 'mp4'
  | 'webm'
  | 'ogg'
  | 'html'
  | 'json'
  | 'zip'
  | 'png'
  | 'jpeg'
  | 'unknown';

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let index = start; index < end && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

const MP4_TOP_LEVEL_BOXES = new Set([
  'ftyp',
  'styp',
  'moov',
  'mdat',
  'free',
  'skip',
  'wide',
  'pdin',
  'uuid',
]);

/**
 * Identifies a downloaded file from its signature bytes so a non-video body is
 * reported as what it is instead of surfacing later as a codec error. Pure, so
 * it is unit-tested without a browser.
 */
export function sniffVideoContainer(head: Uint8Array): VideoContainer {
  if (head.length < 4) return 'unknown';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (ascii(head, 0, 4) === 'OggS') return 'ogg';
  if (head.length >= 8 && MP4_TOP_LEVEL_BOXES.has(ascii(head, 4, 8))) return 'mp4';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  const text = ascii(head, 0, head.length).trimStart().toLowerCase();
  if (text.startsWith('<!do') || text.startsWith('<htm') || text.startsWith('<?xm')) return 'html';
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  return 'unknown';
}

/** True when the signature proves the bytes can never be a playable video. */
export function isDefinitelyNotVideo(container: VideoContainer): boolean {
  return (
    container === 'html' ||
    container === 'json' ||
    container === 'zip' ||
    container === 'png' ||
    container === 'jpeg'
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaErrorMessage(video: HTMLVideoElement, file: File): string {
  const code = video.error?.code;
  const suffix = ` (${formatBytes(file.size)}, ${file.type || 'unknown type'})`;
  if (code === 4) {
    return `This browser cannot decode "${file.name}"${suffix}. Comfy may have returned a codec Chrome does not play (for example HEVC or AV1). Save the workflow output as an H.264 MP4 and import it.`;
  }
  if (code === 3) {
    return `"${file.name}"${suffix} is corrupt or only partially downloaded (media decode error).`;
  }
  return `"${file.name}"${suffix} could not be opened as video. Comfy returned ${file.type || 'an unknown type'}; use an MP4 (H.264) or WebM clip.`;
}

/** Metadata can arrive on any of several events, so watch all of them. */
const METADATA_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'durationchange', 'progress'] as const;

interface MetadataResult {
  probe?: VideoProbe;
  error?: string;
}

function readMetadata(
  video: HTMLVideoElement,
  file: File,
  timeoutMs: number,
): Promise<MetadataResult> {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      for (const event of METADATA_EVENTS) video.removeEventListener(event, check);
      video.removeEventListener('error', onError);
      clearTimeout(timer);
    };
    const finish = (result: MetadataResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const usable = (): VideoProbe | null => {
      const { duration, videoWidth, videoHeight } = video;
      if (videoWidth > 0 && videoHeight > 0 && Number.isFinite(duration) && duration > 0.1) {
        return { duration, width: videoWidth, height: videoHeight };
      }
      return null;
    };
    const check = () => {
      const probe = usable();
      if (probe) finish({ probe });
    };
    const onError = () => finish({ error: mediaErrorMessage(video, file) });
    const timer = setTimeout(
      () =>
        finish({
          error: `Reading "${file.name}" timed out after ${Math.round(timeoutMs / 1000)}s. The browser reported ${formatBytes(
            file.size,
          )}, type ${file.type || 'unknown'}, readyState ${video.readyState}, networkState ${
            video.networkState
          } and duration ${Number.isFinite(video.duration) ? video.duration.toFixed(2) : 'unknown'}. The clip may use a codec this browser cannot decode.`,
        }),
      timeoutMs,
    );

    for (const event of METADATA_EVENTS) video.addEventListener(event, check);
    video.addEventListener('error', onError);
  });
}

function createHiddenVideo(src: string): HTMLVideoElement {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = src;
  video.load();
  return video;
}

/**
 * Waits for an already-mounted element to report usable metadata, with a clear
 * error that names the file size, type and media state instead of a bare timeout.
 */
export async function waitForVideoMetadata(
  video: HTMLVideoElement,
  file: File,
  timeoutMs = 45000,
): Promise<VideoProbe> {
  const result = await readMetadata(video, file, timeoutMs);
  if (result.probe) return result.probe;
  throw new VideoProbeError(result.error ?? `"${file.name}" could not be read as video.`);
}

/**
 * Loads metadata for an object URL so we can reject undecodable clips before
 * they enter the workflow. The object URL itself stays owned by the caller.
 * A stalled blob media load is retried once on a fresh element and URL, which
 * recovers from a dropped media resource without changing the bytes verified.
 */
export async function probeVideo(url: string, file: File, timeoutMs = 45000): Promise<VideoProbe> {
  const first = document.createElement('video');
  first.preload = 'auto';
  first.muted = true;
  first.playsInline = true;

  const finish = (video: HTMLVideoElement) => {
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // Best-effort teardown; the URL belongs to the caller.
    }
  };

  try {
    first.src = url;
    first.load();
    const attempt = await readMetadata(first, file, timeoutMs);
    if (attempt.probe) return attempt.probe;
  } finally {
    finish(first);
  }

  // Second chance: a fresh element and a fresh URL for the same bytes.
  const retryUrl = URL.createObjectURL(file);
  const second = createHiddenVideo(retryUrl);
  try {
    const retry = await readMetadata(second, file, Math.min(timeoutMs, 30000));
    if (retry.probe) return retry.probe;
    throw new VideoProbeError(
      `${retry.error ?? `"${file.name}" could not be read as video.`} Two attempts were made, on separate media elements.`,
    );
  } finally {
    finish(second);
    URL.revokeObjectURL(retryUrl);
  }
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
