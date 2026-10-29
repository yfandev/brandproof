import { describe, expect, it } from 'vitest';
import { GENERATION_ASPECT, fitBox, frameSize } from '../generationImage';

describe('frameSize', () => {
  it('puts a landscape photo in a 16:9 frame without changing its width', () => {
    const frame = frameSize(1920, 1080);
    expect(frame).toEqual({ width: 1920, height: 1080 });
  });

  it('pads a portrait photo instead of cropping it', () => {
    const frame = frameSize(1080, 1920);
    expect(frame.width / frame.height).toBeCloseTo(GENERATION_ASPECT, 2);
    expect(frame.width).toBe(1920);
    expect(frame.height).toBe(1080);
  });

  it('caps the long edge', () => {
    const frame = frameSize(4000, 3000, GENERATION_ASPECT, 1600);
    expect(Math.max(frame.width, frame.height)).toBe(1600);
  });

  it('rejects a photo with no pixels', () => {
    expect(() => frameSize(0, 100)).toThrow(RangeError);
  });
});

describe('fitBox', () => {
  it('centres a portrait photo horizontally, leaving the whole photo visible', () => {
    const box = fitBox(1080, 1920, 1920, 1080);
    expect(box).toEqual({ x: 656, y: 0, width: 608, height: 1080 });
  });

  it('never crops: the fitted box stays inside the frame', () => {
    for (const [w, h] of [
      [1000, 3000],
      [3000, 1000],
      [1280, 720],
      [720, 720],
    ]) {
      const box = fitBox(w, h, 1280, 720);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1280);
      expect(box.y + box.height).toBeLessThanOrEqual(720);
      expect(box.width / box.height).toBeCloseTo(w / h, 1);
    }
  });
});
