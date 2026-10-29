import { useRef, useState } from 'react';
import type { DragEvent, RefObject } from 'react';
import type { ClipSource, ReferenceAsset, VideoAsset } from '../types';
import { DEFAULT_NEGATIVE_PROMPT } from '../lib/scenes';
import { ComfyCloudPanel } from './ComfyCloudPanel';
import { ComfyPanel } from './ComfyPanel';
import { Alert, Card, EmptyState, Pill, formatSeconds } from './ui';

interface VideoPanelProps {
  source: ClipSource;
  onSourceChange: (source: ClipSource) => void;
  video: VideoAsset | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  error: string | null;
  importing: boolean;
  product: ReferenceAsset | null;
  prompt: string;
  brand: string;
  onImport: (file: File) => void;
  onCloudImport: (file: File) => void;
  onCloudGenerated: (blob: Blob, filename: string) => void;
  onClearVideo: () => void;
  onClearError: () => void;
  onGenerated: (blob: Blob, filename: string) => void;
  onDurationChange: (duration: number) => void;
}

function sourceLabel(video: VideoAsset): string {
  if (video.source === 'cloud') return 'Comfy Cloud';
  if (video.source === 'generated') return 'local ComfyUI';
  return 'imported';
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
  brand,
  onImport,
  onCloudImport,
  onCloudGenerated,
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
      description="Generate directly on Comfy Cloud with BrandProof's bundled LTX-2.3 workflow, use a local ComfyUI if you have one, or import a clip made anywhere."
      aside={
        video ? (
          <Pill tone={video.source === 'generated' || video.source === 'cloud' ? 'accent' : 'neutral'} dot>
            {sourceLabel(video)}
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
                Generate on Comfy Cloud with the bundled LTX-2.3 workflow, or import an MP4 you already generated.
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
              id="tab-cloud"
              aria-selected={source === 'cloud'}
              aria-controls="panel-cloud"
              className={`tab ${source === 'cloud' ? 'tab--active' : ''}`}
              onClick={() => onSourceChange('cloud')}
            >
              Comfy Cloud
            </button>
            <button
              type="button"
              role="tab"
              id="tab-local"
              aria-selected={source === 'local'}
              aria-controls="panel-local"
              className={`tab ${source === 'local' ? 'tab--active' : ''}`}
              onClick={() => onSourceChange('local')}
            >
              Local ComfyUI
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
              Import
            </button>
          </div>

          {source === 'cloud' && (
            <div id="panel-cloud" role="tabpanel" aria-labelledby="tab-cloud" className="tabpanel">
              <ComfyCloudPanel
                product={product}
                prompt={prompt}
                negativePrompt={DEFAULT_NEGATIVE_PROMPT}
                brand={brand}
                onCloudGenerated={onCloudGenerated}
                onCloudImport={onCloudImport}
              />
            </div>
          )}

          {source === 'local' && (
            <div id="panel-local" role="tabpanel" aria-labelledby="tab-local" className="tabpanel">
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

          {source === 'import' && (
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
                <p className="workflow-help__title">Import with automatic verification</p>
                <ol className="workflow-help__steps">
                  <li>Generate on Comfy Cloud with the bundled LTX-2.3 workflow.</li>
                  <li>BrandProof downloads the returned MP4 and loads it automatically.</li>
                  <li>OCR verification starts automatically when a brand is set.</li>
                </ol>
                <p className="micro">
                  The clip is processed locally. A generated prompt is not evidence: only the OCR report on this MP4 can
                  support a PASS.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
