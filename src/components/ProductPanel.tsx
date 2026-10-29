import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { Rect, ReferenceAsset } from '../types';
import { RegionPicker } from './RegionPicker';
import { Alert, Card, EmptyState, Pill } from './ui';

export interface ScanLine {
  text: string;
  confidence: number;
}

export interface ScanState {
  status: 'idle' | 'running' | 'done' | 'error';
  lines?: ScanLine[];
  error?: string;
}

interface ProductPanelProps {
  product: ReferenceAsset | null;
  error: string | null;
  busy: boolean;
  region: Rect | null;
  scan: ScanState;
  onSelect: (file: File) => void;
  onClearProduct: () => void;
  onClearError: () => void;
  onRegionChange: (rect: Rect | null) => void;
  onScan: () => void;
  onUseLine: (text: string, target: 'label' | 'brand') => void;
}

export function ProductPanel({
  product,
  error,
  busy,
  region,
  scan,
  onSelect,
  onClearProduct,
  onClearError,
  onRegionChange,
  onScan,
  onUseLine,
}: ProductPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [marking, setMarking] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onSelect(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    handleFiles(event.dataTransfer.files);
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = '';
  };

  return (
    <Card
      index="01 · Source"
      title="Product reference"
      description="The pack shot that every sampled frame is measured against."
      aside={
        product ? (
          <Pill tone="pass" dot>
            loaded
          </Pill>
        ) : (
          <Pill tone="neutral">required</Pill>
        )
      }
    >
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
        onChange={handleInput}
        aria-label="Upload product photo"
      />

      {error && (
        <Alert tone="error" title="Product photo rejected" onDismiss={onClearError}>
          {error}
        </Alert>
      )}

      {!product ? (
        <div
          className={`dropzone ${dragOver ? 'dropzone--over' : ''} ${busy ? 'dropzone--busy' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <div className="dropzone__glyph" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="30" height="30" fill="none">
              <rect x="3.5" y="5.5" width="25" height="21" rx="4" stroke="currentColor" />
              <circle cx="12" cy="13" r="2.6" stroke="currentColor" />
              <path d="M5 22l7.5-6 5.5 4.5 4-3L29 22" stroke="currentColor" strokeLinecap="round" />
            </svg>
          </div>
          <p className="dropzone__title">{busy ? 'Reading image…' : 'Drop your product photo'}</p>
          <p className="dropzone__text">A pack shot where the printed label is legible. PNG, JPEG, WebP or AVIF · up to 25 MB.</p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            Choose photo
          </button>
        </div>
      ) : (
        <div className="product">
          <RegionPicker
            src={product.url}
            alt={`Product reference: ${product.name}`}
            rect={region}
            active={marking}
            onChange={(rect) => {
              onRegionChange(rect);
              setMarking(false);
            }}
            className={marking ? 'region--marking' : ''}
          />

          <div className="product__actions">
            <button
              type="button"
              className={`btn btn--sm ${marking ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setMarking((value) => !value)}
            >
              {marking ? 'Drawing…' : region ? 'Redraw label area' : 'Mark label area'}
            </button>
            {region && !marking && (
              <button
                type="button"
                className="btn btn--subtle btn--sm"
                onClick={() => onRegionChange(null)}
              >
                Clear area
              </button>
            )}
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              Replace
            </button>
            <button type="button" className="btn btn--subtle btn--sm" onClick={onClearProduct}>
              Remove
            </button>
          </div>

          {marking && (
            <p className="micro micro--accent">
              Drag a rectangle over the printed label. The same normalized area is used on every sampled frame.
            </p>
          )}

          <div className="product__meta">
            <div>
              <span className="meta__label">File</span>
              <span className="meta__value meta__value--truncate">{product.name}</span>
            </div>
            <div>
              <span className="meta__label">Pixels</span>
              <span className="meta__value">
                {product.width} × {product.height}
              </span>
            </div>
            <div>
              <span className="meta__label">Colour</span>
              <span className="product__swatches" aria-label="Dominant colours in this photo">
                {product.swatches.map((swatch) => (
                  <span key={swatch} className="swatch" style={{ background: swatch }} title={swatch} />
                ))}
              </span>
            </div>
          </div>

          {region && (
            <p className="micro">
              Label area locked for OCR. Only use this when the label stays in roughly the same place in the clip.
            </p>
          )}

          <div className="scan">
            <div className="scan__head">
              <div>
                <p className="scan__title">Read label text from the photo</p>
                <p className="micro">Runs OCR on the reference so you can prefill the expected text.</p>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={onScan}
                disabled={scan.status === 'running' || busy}
              >
                {scan.status === 'running' ? 'Scanning…' : 'Scan photo'}
              </button>
            </div>

            {scan.status === 'error' && (
              <Alert tone="warn" title="Could not read the photo">
                {scan.error ?? 'OCR failed on this image.'}
              </Alert>
            )}

            {scan.status === 'done' && (
              <div className="scan__results">
                {(scan.lines ?? []).length === 0 ? (
                  <p className="micro">
                    No text was recognised in the {region ? 'marked area' : 'photo'}. Try a sharper crop or enter the text manually.
                  </p>
                ) : (
                  <ul className="scan__list">
                    {(scan.lines ?? []).slice(0, 8).map((line, index) => (
                      <li key={`${line.text}-${index}`} className="scan__line">
                        <span className="scan__text">{line.text}</span>
                        <span className="scan__conf">{Math.round(line.confidence)}%</span>
                        <span className="scan__buttons">
                          <button type="button" className="chipbtn" onClick={() => onUseLine(line.text, 'label')}>
                            + label
                          </button>
                          <button type="button" className="chipbtn" onClick={() => onUseLine(line.text, 'brand')}>
                            set brand
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="micro">
                  OCR suggestions can be wrong — check the exact spelling before verifying. Nothing is uploaded.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {!product && (
        <EmptyState title="Why this matters">
          Frames are compared against this photo for colour profile evidence, and it is the image sent to ComfyUI when
          you generate a clip from this page.
        </EmptyState>
      )}
    </Card>
  );
}
