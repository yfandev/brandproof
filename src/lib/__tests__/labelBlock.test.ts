import { describe, expect, it } from 'vitest';
import type { Bbox, FrameSample, OcrWord, VerifyConfig } from '../../types';
import { adjustmentFromEvidence, type CompactEvidence } from '../catalog';
import { labelBlockBbox } from '../preprocess';
import { normalizeText } from '../text';
import { evaluateFrame, reportInputs } from '../verdict';

const config: VerifyConfig = {
  brand: 'BOTANIKA',
  labelText: '',
  scene: 'luxury-studio',
  strictness: 'balanced',
  coverage: 0.6,
  sampleCount: 6,
  labelCritical: true,
  region: null,
};

function frameWith(words: OcrWord[]): FrameSample {
  const inputs = reportInputs(config);
  return evaluateFrame({
    index: 0,
    time: 0,
    dataUrl: '',
    width: 1280,
    height: 704,
    paletteSimilarity: null,
    rawWords: words,
    text: words.map((word) => word.text).join(' '),
    config,
    threshold: inputs.threshold,
    minWordConfidence: inputs.minWordConfidence,
    brandTokens: inputs.brandTokens,
    labelTokens: inputs.labelTokens,
    region: null,
  });
}

function word(text: string, confidence: number, bbox: Bbox): OcrWord {
  return { text, normalized: normalizeText(text), confidence, bbox };
}

/** Boxes measured on a real LTX-2.3 clip: brand on the body, two lines above it. */
const BRAND: Bbox = { x0: 0.45, y0: 0.52, x1: 0.55, y1: 0.58 };
const LINE_ONE: Bbox = { x0: 0.47, y0: 0.27, x1: 0.535, y1: 0.3 };
const LINE_TWO: Bbox = { x0: 0.47, y0: 0.305, x1: 0.535, y1: 0.335 };
const OFF_COLUMN: Bbox = { x0: 0.05, y0: 0.2, x1: 0.12, y1: 0.24 };

describe('labelBlockBbox', () => {
  it('grows a brand anchor to the lines printed above it in the same column', () => {
    const block = labelBlockBbox(BRAND, [BRAND, LINE_ONE, LINE_TWO, OFF_COLUMN]);
    expect(block.y0).toBeCloseTo(LINE_ONE.y0, 5);
    expect(block.y1).toBeCloseTo(BRAND.y1, 5);
    expect(block.x0).toBeCloseTo(BRAND.x0, 5);
  });

  it('leaves out text in another column and objects much larger than the anchor', () => {
    const cap: Bbox = { x0: 0.44, y0: 0.3, x1: 0.56, y1: 0.62 };
    const block = labelBlockBbox(BRAND, [BRAND, OFF_COLUMN, cap]);
    expect(block).toEqual(BRAND);
  });

  it('returns the anchor unchanged when there is nothing else', () => {
    expect(labelBlockBbox(BRAND, [])).toEqual(BRAND);
  });
});

describe('a garbled brand reading', () => {
  it('is a near miss, not a missing word', () => {
    const frame = frameWith([word('BOTAng', 74, BRAND)]);
    expect(frame.brand[0].status).toBe('near');
    expect(frame.brand[0].matched).toBe('BOTAng');
  });
});

describe('retry instructions', () => {
  const evidence: CompactEvidence = {
    verdict: 'REVIEW',
    headline: 'Needs a human check',
    summary: 'label text was not detected',
    checks: [],
    tokenEvidence: [
      {
        token: 'hydrating',
        kind: 'label',
        finding: 'not-detected',
        bestReading: null,
        bestSimilarity: 0,
        hits: 0,
        missing: 6,
        unreadable: 0,
      },
      {
        token: 'moisturizer',
        kind: 'label',
        finding: 'not-detected',
        bestReading: null,
        bestSimilarity: 0,
        hits: 0,
        missing: 6,
        unreadable: 0,
      },
    ],
    frames: [],
    metrics: {
      sampledFrames: 12,
      readableFrames: 11,
      brandHits: 9,
      labelHits: 0,
      meanConfidence: 78.3,
      readableFraction: 0.92,
    },
    limitations: [],
  };

  it('asks for the existing label to be preserved instead of re-typeset', () => {
    const { adjustment } = adjustmentFromEvidence(evidence, 2);
    expect(adjustment).toContain('Do not re-typeset');
    expect(adjustment).toContain('hydrating');
    expect(adjustment).not.toContain('large in frame');
  });
});
