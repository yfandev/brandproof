import { describe, expect, it } from 'vitest';
import type { Bbox, FrameSample, OcrWord, VerificationReport, VerifyConfig } from '../../types';
import { normalizeText } from '../text';
import { LEGIBLE_LABEL_CONFIDENCE, buildReport, evaluateFrame, reportInputs } from '../verdict';

/**
 * A real run reported REVIEW for a clip where the brand was plainly readable:
 * the label said MERIDIAN in 6 of 11 readable frames at confidence up to 92, one
 * frame read MERIDIAR, and four readable frames carried only other lettering.
 * Per-frame coverage came out at 55% against the 60% target, which a person
 * looking at the clip would not call unreadable.
 */
const config: VerifyConfig = {
  brand: 'MERIDIAN',
  labelText: '',
  scene: 'luxury-studio',
  strictness: 'balanced',
  coverage: 0.6,
  sampleCount: 12,
  labelCritical: true,
  region: null,
};

const BRAND: Bbox = { x0: 0.42, y0: 0.5, x1: 0.58, y1: 0.58 };
const OTHER: Bbox = { x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.26 };

function word(text: string, confidence: number, bbox: Bbox): OcrWord {
  return { text, normalized: normalizeText(text), confidence, bbox };
}

function frameOf(words: OcrWord[], index: number): FrameSample {
  const inputs = reportInputs(config);
  return evaluateFrame({
    index,
    time: index * 0.4,
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
    video: { name: 'video-LTX_2.3_i2v_00002_.mp4', source: 'generated', duration: 4.8 },
    ...inputs,
    referenceSimilarity: null,
  });
}

const clean = (index: number) =>
  frameOf([word('MERIDIAN', 92, BRAND), word('BLACK TEA', 74, OTHER)], index);
const otherText = (index: number) => frameOf([word('BLACK TEA', 74, OTHER)], index);
const nearReading = (index: number) =>
  frameOf([word('MERIDIAR', 90, BRAND), word('BLACK TEA', 74, OTHER)], index);

describe('brand legibility', () => {
  it('passes a brand read clearly in six of eleven readable frames below the coverage target', () => {
    const cleanFrames = [0, 1, 2, 6, 7, 8];
    const frames = Array.from({ length: 12 }, (_, index) =>
      cleanFrames.includes(index)
        ? clean(index)
        : index === 5
          ? nearReading(index)
          : index === 11
            ? frameOf([], index)
            : otherText(index),
    );
    const report = reportOf(frames);
    const brand = report.checks.find((check) => check.id === 'brand');
    expect(report.metrics.readableFrames).toBe(11);
    expect(report.metrics.brandRecall).toBeCloseTo(6 / 11, 3);
    expect(brand?.status).toBe('pass');
    expect(brand?.detail).toContain(String(LEGIBLE_LABEL_CONFIDENCE));
    expect(brand?.detail).toContain('diagnostic');
    expect(report.verdict).toBe('PASS');
  });

  it('keeps the brand at REVIEW when it was read clearly in only one frame', () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      index === 0 ? clean(index) : index === 11 ? frameOf([], index) : otherText(index),
    );
    const report = reportOf(frames);
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('review');
    expect(report.verdict).toBe('REVIEW');
  });

  it('still fails a clip whose brand is repeatedly read as a near miss', () => {
    const frames = Array.from({ length: 12 }, (_, index) =>
      index < 5 ? clean(index) : nearReading(index),
    );
    const report = reportOf(frames);
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('fail');
    expect(report.verdict).toBe('FAIL');
  });

  it('still fails when readable frames never contain the brand', () => {
    const frames = Array.from({ length: 12 }, (_, index) => otherText(index));
    const report = reportOf(frames);
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('fail');
    expect(report.verdict).toBe('FAIL');
  });
});
