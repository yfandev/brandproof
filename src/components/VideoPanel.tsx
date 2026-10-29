import { useRef, useState } from 'react';
import type { DragEvent, RefObject } from 'react';
import type { ReferenceAsset, VideoAsset } from '../types';
import { DEFAULT_NEGATIVE_PROMPT } from '../lib/scenes';
import { ComfyPanel } from './ComfyPanel';
import { Alert, Card, EmptyState, Pill, formatSeconds } from './ui';

interface VideoPanelProps {
  source: 'generate' | 'import';
  onSourceChange: (source: 'generate' | 'import') => void;
  video: VideoAsset | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  error: string | null;
  importing: boolean;
  product: ReferenceAsset | null;
  prompt: string;
  onImport: (file: File) => void;
  onClearVideo: () => void;
  onClearError: () => void;
  onGenerated: (blob: Blob, filename: string) => void;
  onDurationChange: (duration: number) => void;
}

export function VideoPanel({
  source,
  onSourceChange,
  video,
  videoRef,
  error,
  importing,
  product,
  prompt,
  onImport,
  onClearVideo,
  onClearError,
  onGenerated,
  onDurationChange,
}: VideoPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onImport(file);
  };

  return (
    <Card
      index="03 · Clip"
      title="Advertising clip"
      description="Generate it with your own ComfyUI, or import a clip made anywhere — including Comfy Cloud."
      aside={
        video ? (
          <Pill tone={video.source === 'generated' ? 'accent' : 'neutral'} dot>
            {video.source === 'generated' ? 'generated here' : 'imported'}
          </Pill>
        ) : (
          <Pill tone="neutral">no clip</Pill>
        )
      }
    >
      <div className="video-layout">
        <div className="video-layout__stage">
          {video ? (
            <div className="player">
              <video
                ref={videoRef}
                src={video.url}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const duration = event.currentTarget.duration;
                  if (Number.isFinite(duration) && duration > 0) onDurationChange(duration);
                }}
              >
                Your browser cannot play this clip.
              </video>
            </div>
          ) : (
            <div className="player player--empty">
              <EmptyState
                title="No clip loaded yet"
                icon={
                  <svg viewBox="0 0 32 32" width="30" height="30" fill="none">
                    <rect x="3" y="7" width="26" height="18" rx="4" stroke="currentColor" />
                    <path d="M13 12.5l7 3.5-7 3.5v-7z" fill="currentColor" />
                  </svg>
                }
              >
                Generate a clip with a local ComfyUI, or import an MP4 exported from Comfy Cloud.
              </EmptyState>
            </div>
          )}

          {video && (
            <div className="player__meta">
              <div className="player__file" title={video.name}>
                <span className="meta__label">Source file</span>
                <span className="player__filename">{video.name}</span>
              </div>
              <div className="player__stats">
                <span>{formatSeconds(video.duration)}</span>
                <span>{video.width && video.height ? `${video.width}×${video.height}` : '—'}</span>
                <span>{(video.size / (1024 * 1024)).toFixed(1)} MB</span>
              </div>
              <button type="button" className="btn btn--subtle btn--sm" onClick={onClearVideo}>
                Remove clip
              </button>
            </div>
          )}

          {error && (
            <Alert tone="error" title="Clip not loaded" onDismiss={onClearError}>
              {error}
            </Alert>
          )}
        </div>

        <div className="video-layout__controls">
          <div className="tabs" role="tablist" aria-label="Clip source">
            <button
              type="button"
              role="tab"
              id="tab-generate"
              aria-selected={source === 'generate'}
              aria-controls="panel-generate"
              className={`tab ${source === 'generate' ? 'tab--active' : ''}`}
              onClick={() => onSourceChange('generate')}
            >
              Generate video
            </button>
            <button
              type="button"
              role="tab"
              id="tab-import"
              aria-selected={source === 'import'}
              aria-controls="panel-import"
              className={`tab ${source === 'import' ? 'tab--active' : ''}`}
              onClick={() => onSourceChange('import')}
            >
              Import existing video
            </button>
          </div>

          {source === 'import' ? (
            <div id="panel-import" role="tabpanel" aria-labelledby="tab-import" className="tabpanel">
              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                accept="video/mp4,video/webm,video/ogg,video/quicktime"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onImport(file);
                  event.target.value = '';
                }}
                aria-label="Import an existing video"
              />
              <div
                className={`dropzone dropzone--video ${dragOver ? 'dropzone--over' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <p className="dropzone__title">{importing ? 'Reading clip…' : 'Drop an MP4 or WebM'}</p>
                <p className="dropzone__text">
                  H.264 MP4 plays everywhere. WebM works in Chromium and Firefox. MOV/HEVC usually will not decode in a
                  browser.
                </p>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => inputRef.current?.click()}
                  disabled={importing}
                >
                  Choose video
                </button>
              </div>

              <div className="workflow-help">
                <p className="workflow-help__title">Generate the clip in Comfy Cloud, then import it</p>
                <ol className="workflow-help__steps">
                  <li>Open the Wan 2.2 5B workflow in Comfy Cloud and upload this product photo to Load Image.</li>
                  <li>Paste the prompt from step 02, keep the label text explicit, and run the workflow.</li>
                  <li>Download the MP4 result, then drop it here. Verification runs locally on this clip.</li>
                </ol>
                <p className="micro">
                  Comfy Cloud needs paid credits, so BrandProof does not call it with an embedded key. Direct generation
                  here is for self-hosted ComfyUI only.
                </p>
              </div>
            </div>
          ) : (
            <div id="panel-generate" role="tabpanel" aria-labelledby="tab-generate" className="tabpanel">
              <ComfyPanel
                imageFile={product?.file ?? null}
                imageWidth={product?.width ?? 0}
                imageHeight={product?.height ?? 0}
                prompt={prompt}
                negativePrompt={DEFAULT_NEGATIVE_PROMPT}
                onGenerated={onGenerated}
              />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
