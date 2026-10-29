import { describe, expect, it } from 'vitest';
import type { OcrWord } from '../../types';
import {
  adaptiveThresholdPixels,
  bboxIoU,
  contrastPixels,
  deriveLabelRegion,
  grayscalePixels,
  mapBboxToFrame,
  mergeOcrWords,
} from '../preprocess';
import { normalizeText, textFromWords } from '../text';

function word(
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  confidence = 90,
): OcrWord {
  return {
    text,
    normalized: normalizeText(text),
    confidence,
    bbox: { x0, y0, x1, y1 },
  };
}

describe('pixel preprocessing', () => {
  it('converts to luminance while preserving alpha', () => {
    const input = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]);
    const output = grayscalePixels(input);
    expect(output[0]).toBe(54);
    expect(output[1]).toBe(54);
    expect(output[2]).toBe(54);
    expect(output[3]).toBe(255);
    expect(output[4]).toBe(182);
    expect(output[7]).toBe(128);
  });

  it('expands contrast around mid-grey', () => {
    const output = contrastPixels(new Uint8ClampedArray([100, 100, 100, 255]), 2);
    expect([output[0], output[1], output[2]]).toEqual([72, 72, 72]);
    expect(output[3]).toBe(255);
  });

  it('thresholds dark text against a light local background', () => {
    const width = 5;
    const height = 5;
    const data = new Uint8ClampedArray(width * height * 4).fill(240);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const center = (2 * width + 2) * 4;
    data[center] = 30;
    data[center + 1] = 30;
    data[center + 2] = 30;

    const output = adaptiveThresholdPixels(data, width, height, 5, 8, false);
    expect(output[center]).toBe(0);
    expect(output[0]).toBe(255);
    expect(output[3]).toBe(255);
  });

  it('can invert a threshold for light text on a dark label', () => {
    const width = 5;
    const height = 5;
    const data = new Uint8ClampedArray(width * height * 4).fill(40);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const center = (2 * width + 2) * 4;
    data[center] = 230;
    data[center + 1] = 230;
    data[center + 2] = 230;

    const output = adaptiveThresholdPixels(data, width, height, 5, 8, true);
    expect(output[center]).toBe(0);
    expect(output[0]).toBe(255);
  });
});

describe('crop-coordinate mapping', () => {
  it('maps OCR pixels from a crop back to normalized full-frame coordinates', () => {
    const mapped = mapBboxToFrame(
      { x0: 30, y0: 15, x1: 90, y1: 60 },
      { frameWidth: 1000, frameHeight: 500, cropX: 200, cropY: 100, scale: 3 },
    );
    expect(mapped.x0).toBeCloseTo(0.21, 6);
    expect(mapped.y0).toBeCloseTo(0.21, 6);
    expect(mapped.x1).toBeCloseTo(0.23, 6);
    expect(mapped.y1).toBeCloseTo(0.24, 6);
  });

  it('clamps mapped boxes to the frame', () => {
    const mapped = mapBboxToFrame(
      { x0: -50, y0: -50, x1: 500, y1: 500 },
      { frameWidth: 100, frameHeight: 100, cropX: 0, cropY: 0, scale: 1 },
    );
    expect(mapped).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });
});

describe('label-region selection', () => {
  it('expands the brand box into a generous label neighborhood', () => {
    const region = deriveLabelRegion({ x0: 0.4, y0: 0.4, x1: 0.55, y1: 0.45 });
    expect(region).not.toBeNull();
    expect(region!.x).toBeLessThan(0.4);
    expect(region!.y).toBeLessThan(0.4);
    expect(region!.x + region!.w).toBeGreaterThan(0.55);
    expect(region!.y + region!.h).toBeGreaterThan(0.45);
    expect(region!.w * region!.h).toBeLessThan(0.9);
  });

  it('rejects a degenerate anchor', () => {
    expect(deriveLabelRegion({ x0: 0.4, y0: 0.4, x1: 0.4, y1: 0.4 })).toBeNull();
  });
});

describe('multi-pass word merging', () => {
  it('keeps the highest-confidence reading for duplicate boxes', () => {
    const merged = mergeOcrWords([
      word('HYDRATING', 0.1, 0.2, 0.3, 0.25, 60),
      word('HYDRATING', 0.101, 0.201, 0.301, 0.251, 95),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe(95);
    expect(merged[0].bbox.x0).toBe(0.101);
  });

  it('keeps the same word in different places as separate evidence', () => {
    const merged = mergeOcrWords([
      word('SERUM', 0.1, 0.2, 0.2, 0.25),
      word('SERUM', 0.5, 0.2, 0.6, 0.25),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('does not merge different readings at the same box', () => {
    const merged = mergeOcrWords([
      word('SERUM', 0.1, 0.2, 0.2, 0.25),
      word('SERUMS', 0.1, 0.2, 0.2, 0.25),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('computes real box overlap', () => {
    expect(bboxIoU({ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 }, { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 })).toBe(1);
    expect(bboxIoU({ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 }, { x0: 0.5, y0: 0.6, x1: 0.7, y1: 0.8 })).toBe(0);
  });
});

describe('OCR text reconstruction', () => {
  it('keeps visual lines separated for display and matching', () => {
    const text = textFromWords([
      word('AURELIA', 0.1, 0.1, 0.3, 0.14),
      word('SERUM', 0.35, 0.1, 0.5, 0.14),
      word('30', 0.1, 0.3, 0.15, 0.34),
    ]);
    expect(text).toBe('AURELIA SERUM\n30');
  });
});
