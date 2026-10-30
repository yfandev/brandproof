import { describe, expect, it } from 'vitest';
import { cropRectForSubject, subjectBoundsFromPixels } from '../productFrame';

describe('subjectBoundsFromPixels', () => {
  it('finds the product against a flat backdrop', () => {
    const width = 200;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4).fill(240);
    for (let y = 20; y < 80; y += 1) {
      for (let x = 80; x < 120; x += 1) {
        const index = (y * width + x) * 4;
        data[index] = 30;
        data[index + 1] = 40;
        data[index + 2] = 35;
      }
    }
    const bounds = subjectBoundsFromPixels({ data, width, height })!;
    expect(bounds.x).toBeCloseTo(0.4, 1);
    expect(bounds.w).toBeCloseTo(0.2, 1);
    expect(bounds.y).toBeCloseTo(0.2, 1);
    expect(bounds.h).toBeCloseTo(0.6, 1);
  });

  it('returns null when nothing stands out from the backdrop', () => {
    const width = 40;
    const height = 40;
    const data = new Uint8ClampedArray(width * height * 4).fill(200);
    expect(subjectBoundsFromPixels({ data, width, height })).toBeNull();
  });
});

describe('cropRectForSubject', () => {
  it('adds a margin around the product', () => {
    const crop = cropRectForSubject({ x: 0.4, y: 0.3, w: 0.2, h: 0.4 })!;
    expect(crop.x).toBeLessThan(0.4);
    expect(crop.y).toBeLessThan(0.3);
    expect(crop.x + crop.w).toBeGreaterThan(0.6);
    expect(crop.y + crop.h).toBeGreaterThan(0.7);
  });

  it('declines when the box is noise or already fills the photo', () => {
    expect(cropRectForSubject({ x: 0.4, y: 0.4, w: 0.01, h: 0.01 })).toBeNull();
    expect(cropRectForSubject({ x: 0, y: 0, w: 0.99, h: 0.99 })).toBeNull();
    expect(cropRectForSubject(null)).toBeNull();
  });

  it('keeps the crop inside the photo', () => {
    const crop = cropRectForSubject({ x: 0, y: 0, w: 0.5, h: 0.5 })!;
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1);
    expect(crop.y + crop.h).toBeLessThanOrEqual(1);
  });
});
