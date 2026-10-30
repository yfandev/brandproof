import { describe, expect, it } from 'vitest';
import type { TokenFinding } from '../../types';
import { labelNeedsCloseUp, type CompactEvidence } from '../catalog';
import {
  containsRegion,
  regionArea,
  retryReferenceRegion,
  subjectRegionFromPixels,
} from '../labelCrop';

function evidence(
  tokens: Array<{ kind: 'brand' | 'label'; token: string; finding: TokenFinding }>,
): CompactEvidence {
  return {
    verdict: 'REVIEW',
    headline: 'Needs a human check',
    summary: 'summary',
    checks: [],
    tokenEvidence: tokens.map((entry) => ({
      ...entry,
      bestReading: null,
      bestSimilarity: 0,
      hits: 0,
      missing: 4,
      unreadable: 0,
    })),
    frames: [],
    metrics: {
      sampledFrames: 12,
      readableFrames: 11,
      brandHits: 9,
      labelHits: 0,
      meanConfidence: 78,
      readableFraction: 0.9,
    },
    limitations: [],
  };
}

describe('labelNeedsCloseUp', () => {
  it('asks for a close-up when the label was never read', () => {
    expect(
      labelNeedsCloseUp(evidence([{ kind: 'label', token: 'hydrating', finding: 'not-detected' }])),
    ).toBe(true);
  });

  it('asks for a close-up when the label read as different letters', () => {
    expect(
      labelNeedsCloseUp(evidence([{ kind: 'label', token: 'hydrating', finding: 'visibly-distorted' }])),
    ).toBe(true);
  });

  it('asks for a close-up when the label was only partly legible', () => {
    expect(
      labelNeedsCloseUp(evidence([{ kind: 'label', token: 'moisturizer', finding: 'unreadable' }])),
    ).toBe(true);
  });

  it('does not switch image when every label token was verified', () => {
    expect(
      labelNeedsCloseUp(evidence([{ kind: 'label', token: 'hydrating', finding: 'verified' }])),
    ).toBe(false);
  });

  it('ignores a brand-only configuration', () => {
    expect(
      labelNeedsCloseUp(evidence([{ kind: 'brand', token: 'botanika', finding: 'verified' }])),
    ).toBe(false);
  });

  it('does nothing without evidence', () => {
    expect(labelNeedsCloseUp(null)).toBe(false);
  });
});

describe('retryReferenceRegion', () => {
  const text = { x: 0.42, y: 0.44, w: 0.16, h: 0.18 };
  const subject = { x: 0.38, y: 0.2, w: 0.24, h: 0.62 };

  it('crops the whole package instead of the label block', () => {
    const region = retryReferenceRegion({ text, subject })!;
    expect(region).not.toBeNull();
    expect(regionArea(region)).toBeGreaterThan(regionArea(text) * 3);
  });

  it('keeps the whole product height in frame, with a margin', () => {
    const region = retryReferenceRegion({ text, subject })!;
    expect(region.y).toBeLessThan(subject.y);
    expect(region.y + region.h).toBeGreaterThan(subject.y + subject.h);
  });

  it('never crops the required wording out of the reference', () => {
    const wideText = { x: 0.05, y: 0.1, w: 0.5, h: 0.3 };
    const region = retryReferenceRegion({ text: wideText, subject: { x: 0.45, y: 0.5, w: 0.3, h: 0.4 } })!;
    expect(containsRegion(region, wideText)).toBe(true);
  });

  it('falls back to a padded text block when no product can be separated', () => {
    const region = retryReferenceRegion({ text, subject: null })!;
    expect(region.h).toBeGreaterThan(text.h);
    expect(regionArea(region)).toBeLessThanOrEqual(0.9);
  });

  it('ignores a subject that already fills the photo', () => {
    const region = retryReferenceRegion({ text, subject: { x: 0, y: 0, w: 1, h: 0.95 } })!;
    expect(regionArea(region)).toBeLessThan(0.9);
  });

  it('declines when there is nothing to crop', () => {
    expect(retryReferenceRegion({ text: null, subject: null })).toBeNull();
  });
});

describe('subjectRegionFromPixels', () => {
  it('finds a product against a flat backdrop', () => {
    const width = 200;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 20; y < 80; y += 1) {
      for (let x = 80; x < 120; x += 1) {
        const index = (y * width + x) * 4;
        data[index] = 30;
        data[index + 1] = 40;
        data[index + 2] = 35;
      }
    }
    const region = subjectRegionFromPixels({ data, width, height })!;
    expect(region.x).toBeCloseTo(0.4, 1);
    expect(region.w).toBeCloseTo(0.2, 1);
    expect(region.y).toBeCloseTo(0.2, 1);
    expect(region.h).toBeCloseTo(0.6, 1);
  });

  it('returns null when nothing stands out from the backdrop', () => {
    const width = 40;
    const height = 40;
    const data = new Uint8ClampedArray(width * height * 4).fill(200);
    expect(subjectRegionFromPixels({ data, width, height })).toBeNull();
  });
});
