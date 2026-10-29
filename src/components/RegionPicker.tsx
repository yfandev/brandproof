import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Rect } from '../types';

interface RegionPickerProps {
  src: string;
  alt: string;
  rect: Rect | null;
  active: boolean;
  onChange: (rect: Rect) => void;
  overlay?: ReactNode;
  className?: string;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundRect(rect: Rect): Rect {
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) };
}

export function RegionPicker({ src, alt, rect, active, onChange, overlay, className = '' }: RegionPickerProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);

  const shown = active && draft ? draft : rect;

  const pointFor = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = frameRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: clamp01((event.clientX - bounds.left) / bounds.width),
      y: clamp01((event.clientY - bounds.top) / bounds.height),
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active) return;
    event.preventDefault();
    const point = pointFor(event);
    frameRef.current?.setPointerCapture(event.pointerId);
    setDragStart(point);
    setDraft({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || !dragStart) return;
    const point = pointFor(event);
    setDraft({
      x: Math.min(dragStart.x, point.x),
      y: Math.min(dragStart.y, point.y),
      w: Math.abs(point.x - dragStart.x),
      h: Math.abs(point.y - dragStart.y),
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || !dragStart) return;
    const computed = draft;
    setDragStart(null);
    setDraft(null);
    if (!computed || computed.w < 0.04 || computed.h < 0.04) return;
    onChange(roundRect(computed));
    if (frameRef.current?.hasPointerCapture(event.pointerId)) {
      frameRef.current.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={frameRef}
      className={`region ${active ? 'region--active' : ''} ${className}`.trim()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        setDragStart(null);
        setDraft(null);
      }}
    >
      <img className="region__image" src={src} alt={alt} draggable={false} />
      {overlay}
      {shown && shown.w > 0.005 && shown.h > 0.005 && (
        <div
          className="region__selection"
          style={{
            left: `${shown.x * 100}%`,
            top: `${shown.y * 100}%`,
            width: `${shown.w * 100}%`,
            height: `${shown.h * 100}%`,
          }}
        >
          {active && <span className="region__tag">label area</span>}
        </div>
      )}
      {active && !shown && (
        <div className="region__hint" aria-hidden="true">
          Drag a box around the printed label
        </div>
      )}
    </div>
  );
}
