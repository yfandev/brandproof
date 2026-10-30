import { describe, expect, it } from 'vitest';
import type { TokenFinding } from '../../types';
import { labelNeedsCloseUp, type CompactEvidence } from '../catalog';

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
