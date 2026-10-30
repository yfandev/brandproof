import { describe, expect, it } from 'vitest';
import type { Bbox, FrameSample, OcrWord, VerificationReport, VerifyConfig } from '../../types';
import { normalizeText } from '../text';
import { LEGIBLE_LABEL_CONFIDENCE, buildReport, evaluateFrame, reportInputs } from '../verdict';

/**
 * The label rule asks the question a person asks: can this text be read?
 * A clip that holds the label still for two good frames is legible even when the
 * rest of the sampled frames are motion-blurred, so per-frame coverage is
 * reported as a diagnostic instead of gating the verdict.
 */
const config: VerifyConfig = {
  brand: 'BOTANIKA',
  labelText: 'HYDRATING',
  scene: 'luxury-studio',
  strictness: 'balanced',
  coverage: 0.6,
  sampleCount: 12,
  labelCritical: true,
  region: null,
};

const BRAND: Bbox = { x0: 0.45, y0: 0.52, x1: 0.55, y1: 0.58 };
const LABEL: Bbox = { x0: 0.47, y0: 0.27, x1: 0.535, y1: 0.3 };

function word(text: string, confidence: number, bbox: Bbox): OcrWord {
  return { text, normalized: normalizeText(text), confidence, bbox };
}

function frameOf(words: OcrWord[], index: number): FrameSample {
  const inputs = reportInputs(config);
  return evaluateFrame({
    index,
    time: index * 0.35,
    dataUrl: '',
    width: 1280,
    height: 704,
    paletteSimilarity: null,
    rawWords: words,
    text: words.map((entry) => entry.text).join(' '),
    config,
    threshold: inputs.threshold,
    minWordConfidence: inputs.minWordConfidence,
    brandTokens: inputs.brandTokens,
    labelTokens: inputs.labelTokens,
    region: null,
  });
}

function reportOf(frames: FrameSample[]): VerificationReport {
  const inputs = reportInputs(config);
  return buildReport({
    config,
    frames,
    video: { name: 'clip.mp4', source: 'generated', duration: 4.8 },
    ...inputs,
    referenceSimilarity: null,
  });
}

/** Twelve frames of a clean brand; the label is only sharp in the given frames. */
function clip(sharpLabelFrames: number[], labelConfidence = 93): FrameSample[] {
  return Array.from({ length: 12 }, (_, index) =>
    frameOf(
      sharpLabelFrames.includes(index)
        ? [word('BOTANIKA', 91, BRAND), word('HYDRATING', labelConfidence, LABEL)]
        : [word('BOTANIKA', 91, BRAND)],
      index,
    ),
  );
}

describe('label legibility', () => {
  it('passes a label that is clear in two frames, even when per-frame coverage is low', () => {
    const report = reportOf(clip([0, 1]));
    const label = report.checks.find((check) => check.id === 'label');
    expect(label?.status).toBe('pass');
    expect(label?.detail).toContain(String(LEGIBLE_LABEL_CONFIDENCE));
    // Coverage is still reported, just no longer the gate.
    expect(report.metrics.labelRecall).toBeCloseTo(2 / 12, 3);
    expect(report.verdict).toBe('PASS');
  });

  it('keeps a label that was only read clearly in one frame at REVIEW', () => {
    const report = reportOf(clip([0]));
    expect(report.checks.find((check) => check.id === 'label')?.status).toBe('review');
    expect(report.verdict).toBe('REVIEW');
  });

  it('does not count a confident-looking read below the legible confidence as clear', () => {
    const report = reportOf(clip([0, 1, 2, 3], LEGIBLE_LABEL_CONFIDENCE - 18));
    const label = report.checks.find((check) => check.id === 'label');
    expect(label?.status).toBe('review');
    expect(label?.detail).toContain('HYDRATING');
    expect(report.verdict).toBe('REVIEW');
  });

  it('still records the per-token strong reads in the evidence', () => {
    const report = reportOf(clip([0, 1]));
    const evidence = report.tokenEvidence.find((entry) => entry.token === 'hydrating');
    expect(evidence?.strongHits).toBe(2);
  });
});
