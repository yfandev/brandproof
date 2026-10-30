import { describe, expect, it } from 'vitest';
import type { OcrWord } from '../../types';
import {
  MIN_LABEL_LINE_FRACTION,
  labelOverlayLines,
  layoutLabelLines,
} from '../labelReference';

function word(text: string, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return {
    text,
    normalized: text.toLowerCase(),
    confidence: 80,
    bbox: { x0, y0, x1, y1 },
  };
}

const crop = { x: 0.3, y: 0.2, w: 0.4, h: 0.6 };

describe('labelOverlayLines', () => {
  it('groups words printed on the same line and keeps them in reading order', () => {
    const lines = labelOverlayLines([
      word('MOISTURIZER', 0.45, 0.5, 0.55, 0.53),
      word('HYDRATING', 0.44, 0.46, 0.56, 0.49),
      word('NATURAL', 0.44, 0.55, 0.5, 0.58),
      word('INGREDIENTS', 0.51, 0.55, 0.6, 0.58),
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      'HYDRATING',
      'MOISTURIZER',
      'NATURAL INGREDIENTS',
    ]);
  });

  it('drops junk that is not a printed word', () => {
    expect(labelOverlayLines([word('|', 0.4, 0.4, 0.41, 0.41)])).toEqual([]);
  });
});

describe('layoutLabelLines', () => {
  const lines = [
    { text: 'HYDRATING', box: { x0: 0.4, y0: 0.45, x1: 0.6, y1: 0.452 } },
    { text: 'MOISTURIZER', box: { x0: 0.4, y0: 0.5, x1: 0.6, y1: 0.505 } },
  ];

  it('enforces a line size the render can actually reproduce', () => {
    const placed = layoutLabelLines(lines, crop, { width: 1280, height: 720 });
    const minimum = 720 * MIN_LABEL_LINE_FRACTION;
    expect(placed.every((line) => line.size >= minimum)).toBe(true);
  });

  it('places each line at its real position inside the crop', () => {
    const placed = layoutLabelLines(lines, crop, { width: 1000, height: 800 });
    // The line box spans 0.45–0.452, so its centre lands just below the middle of
    // a crop that starts at 0.2 and spans 0.6.
    expect(placed[0].y).toBeCloseTo(((0.451 - 0.2) / 0.6) * 800, 1);
    expect(placed[0].y).toBeLessThan(placed[1].y);
  });

  it('maps x into the output width', () => {
    const placed = layoutLabelLines(
      [{ text: 'BOTANIKA', box: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.42 } }],
      crop,
      { width: 1000, height: 800 },
    );
    expect(placed[0].x).toBeCloseTo(((0.5 - 0.3) / 0.4) * 1000, 0);
  });

  it('has nothing to place without lines or a canvas', () => {
    expect(layoutLabelLines([], crop, { width: 1280, height: 720 })).toEqual([]);
    expect(layoutLabelLines(lines, crop, { width: 0, height: 720 })).toEqual([]);
  });
});
