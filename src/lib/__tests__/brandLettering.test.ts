import { describe, expect, it } from 'vitest';
import type { Bbox, FrameSample, OcrWord, VerificationReport, VerifyConfig } from '../../types';
import { normalizeText } from '../text';
import { buildReport, evaluateFrame, reportInputs } from '../verdict';

/**
 * These fixtures come from an actual LTX-2.3 clip posted by the LTX workflow in
 * Comfy Cloud. OCR over its frames returned a small "BOTANIKA" on the upper
 * label and a large "BOTANKA" on the body, with the boxes below. BrandProof
 * passed that clip, because 0.875 similarity clears the balanced 0.87
 * threshold. The geometry and confidences here are the measured ones.
 */
const config: VerifyConfig = {
  brand: 'BOTANIKA',
  labelText: '',
  scene: 'luxury-studio',
  strictness: 'balanced',
  coverage: 0.6,
  sampleCount: 11,
  labelCritical: true,
  region: null,
};

const UPPER_LABEL: Bbox = { x0: 0.45, y0: 0.15, x1: 0.55, y1: 0.215 };
const BOTTLE_BODY: Bbox = { x0: 0.42, y0: 0.91, x1: 0.57, y1: 1.02 };

function word(text: string, confidence: number, bbox: Bbox): OcrWord {
  return { text, normalized: normalizeText(text), confidence, bbox };
}

function frameOf(words: OcrWord[], index = 0): FrameSample {
  const inputs = reportInputs(config);
  return evaluateFrame({
    index,
    time: index * 0.4,
    dataUrl: '',
    width: 1280,
    height: 704,
    paletteSimilarity: 0.6,
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
    video: { name: 'video-LTX_2.3_i2v_00001_.mp4', source: 'generated', duration: 4.8 },
    ...inputs,
    referenceSimilarity: 0.21,
  });
}

describe('a one-letter brand change is not an exact match', () => {
  it('reads BOTANKA as a near miss, not the required word', () => {
    const frame = frameOf([word('BOTANKA', 92, BOTTLE_BODY)]);
    expect(frame.brand[0].status).toBe('near');
    expect(frame.brand[0].matched).toBe('BOTANKA');
    expect(frame.status).toBe('fail');
  });

  it('fails a clip whose body label is printed without the letter', () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      frameOf([word('BOTANKA', 92, BOTTLE_BODY)], index),
    );
    const report = reportOf(frames);
    expect(report.verdict).toBe('FAIL');
    const brand = report.checks.find((check) => check.id === 'brand');
    expect(brand?.status).toBe('fail');
    expect(brand?.detail).toContain('BOTANKA');
  });

  it('still matches the clean render in every frame', () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      frameOf([word('BOTANIKA', 92, BOTTLE_BODY)], index),
    );
    const report = reportOf(frames);
    expect(report.verdict).toBe('PASS');
    expect(report.frames[0].brand[0].status).toBe('match');
  });
});

describe('altered lettering printed at a different size', () => {
  it('does not hide a small copy inside the large word box', () => {
    const inside: Bbox = { x0: 0.47, y0: 0.94, x1: 0.52, y1: 0.965 };
    const frame = frameOf([
      word('BOTANIKA', 92, BOTTLE_BODY),
      word('BOTANKA', 88, inside),
    ]);
    expect(frame.extraText).toHaveLength(1);
    expect(frame.extraText[0].text).toBe('BOTANKA');
  });

  it('fails a clip that prints the correct and the altered word in most frames', () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      frameOf(
        [word('BOTANIKA', 70, UPPER_LABEL), word('BOTANKA', 92, BOTTLE_BODY)],
        index,
      ),
    );
    const report = reportOf(frames);
    const extra = report.checks.find((check) => check.id === 'extra-text');
    expect(extra?.status).toBe('fail');
    expect(extra?.detail).toContain('BOTANKA');
    expect(report.verdict).toBe('FAIL');
  });
});

describe('partially read brand coverage', () => {
  const clean = (index: number) => frameOf([word('BOTANIKA', 88, BOTTLE_BODY)], index);
  const clipped = (index: number) => frameOf([word('gOTANIKA', 62, BOTTLE_BODY)], index);

  it('passes when a clipped leading edge fills the coverage target without altered readings', () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      index < 4 ? clean(index) : clipped(index),
    );
    const report = reportOf(frames);
    const brand = report.checks.find((check) => check.id === 'brand');
    expect(brand?.status).toBe('pass');
    expect(brand?.detail).toContain('clipped');
    expect(report.verdict).toBe('PASS');
  });

  it('passes when two frames read the brand cleanly, even with clipped edges elsewhere', () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      index < 2 ? clean(index) : clipped(index),
    );
    const report = reportOf(frames);
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('pass');
    expect(report.verdict).toBe('PASS');
  });

  it('stays in review when the brand was read cleanly in a single frame', () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      index === 0 ? clean(index) : clipped(index),
    );
    const report = reportOf(frames);
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('review');
    expect(report.verdict).toBe('REVIEW');
  });

  it('never passes on partial reads alone', () => {
    const frames = Array.from({ length: 11 }, (_, index) => clipped(index));
    const report = reportOf(frames);
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('review');
    expect(report.verdict).toBe('REVIEW');
  });

  it('does not let a near reading through on the partial-coverage path', () => {
    // Two contradictory readings are repeated evidence; one is treated as an
    // OCR miss, so the legibility rule needs two to block the pass.
    const frames = Array.from({ length: 11 }, (_, index) =>
      index < 4 ? clean(index) : index < 6 ? frameOf([word('BOTANKA', 90, BOTTLE_BODY)], index) : clipped(index),
    );
    const report = reportOf(frames);
    expect(report.checks.find((check) => check.id === 'brand')?.status).not.toBe('pass');
  });
});
