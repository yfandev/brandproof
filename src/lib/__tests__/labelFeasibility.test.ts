import { describe, expect, it } from 'vitest';
import { labelFeasibility, medianLineHeightPx } from '../labelFeasibility';

function words(heights: number[]) {
  return heights.map((height, index) => ({
    bbox: { x0: 0.4, y0: 0.4 + index * 0.01, x1: 0.6, y1: 0.4 + index * 0.01 + height },
  }));
}

describe('medianLineHeightPx', () => {
  it('measures a printed line in photo pixels', () => {
    // 0.02 of a 1264 px photo is about 25 px.
    expect(medianLineHeightPx(words([0.02, 0.02, 0.03]), 1264)).toBe(25);
  });

  it('returns null when no text was read', () => {
    expect(medianLineHeightPx([], 1264)).toBeNull();
  });
});

describe('labelFeasibility', () => {
  it('calls a ten-pixel line in the photo hopeless for a 720p render', () => {
    const result = labelFeasibility(10, { photoHeightPx: 1264 })!;
    expect(result.renderPx).toBeLessThan(10);
    expect(result.status).toBe('hopeless');
    expect(result.message).toContain('paint plausible-looking text');
    expect(result.message).toContain('the only way to make this check passable');
  });

  it('calls a marginal line marginal', () => {
    const result = labelFeasibility(40, { photoHeightPx: 720 })!;
    expect(result.renderPx).toBe(40);
    expect(result.status).toBe('marginal');
  });

  it('accepts a clearly legible line', () => {
    const result = labelFeasibility(80, { photoHeightPx: 720 })!;
    expect(result.status).toBe('ok');
  });

  it('has nothing to say without a measurement', () => {
    expect(labelFeasibility(null)).toBeNull();
    expect(labelFeasibility(0)).toBeNull();
  });
});
