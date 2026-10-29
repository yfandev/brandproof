import { describe, expect, it } from 'vitest';
import type { Bbox, FrameSample, OcrWord, VerificationReport, VerifyConfig } from '../../types';
import { normalizeText } from '../text';
import { buildReport, evaluateFrame, reportInputs } from '../verdict';

/**
 * Measured on a real LTX-2.3 clip: the bottle was printed "HYCGANG /
 * MCISTURIZER" above a clean "BOTANIKA", and Tesseract returned those strings at
 * 28-35 and 58 confidence. Every reading fell under the 45 confidence floor, so
 * the label row said "none of the expected label tokens could be read" instead
 * of reporting lettering that visibly changed.
 */
const config: VerifyConfig = {
  brand: 'BOTANIKA',
  labelText: 'HYDRATING\nMOISTURIZER',
  scene: 'luxury-studio',
  strictness: 'balanced',
  coverage: 0.6,
  sampleCount: 11,
  labelCritical: true,
  region: null,
};

const BRAND: Bbox = { x0: 0.45, y0: 0.52, x1: 0.55, y1: 0.58 };
const LABEL_ONE: Bbox = { x0: 0.47, y0: 0.27, x1: 0.535, y1: 0.3 };
const LABEL_TWO: Bbox = { x0: 0.47, y0: 0.305, x1: 0.535, y1: 0.335 };

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
    paletteSimilarity: 0.26,
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
    referenceSimilarity: 0.26,
  });
}

describe('weak but real readings of required text', () => {
  it('treats a different spelling as a visible change even at low confidence', () => {
    const frame = frameOf([word('BOTANIKA', 91, BRAND), word('HYRANTING', 35, LABEL_ONE)]);
    const label = frame.label.find((entry) => entry.expected === 'hydrating');
    expect(label?.status).toBe('near');
    expect(label?.matched).toBe('HYRANTING');
  });

  it('does not treat a low-confidence exact read as a match or a change', () => {
    const frame = frameOf([word('BOTANIKA', 91, BRAND), word('HYDRATING', 30, LABEL_ONE)]);
    const label = frame.label.find((entry) => entry.expected === 'hydrating');
    expect(label?.status).toBe('unreadable');
  });

  it('fails the label check when the render prints look-alike words in most frames', () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      frameOf(
        [
          word('BOTANIKA', 91, BRAND),
          word('HYRANTING', 35, LABEL_ONE),
          word('MOISITURIZER', 58, LABEL_TWO),
        ],
        index,
      ),
    );
    const report = reportOf(frames);
    const label = report.checks.find((check) => check.id === 'label');
    expect(label?.status).toBe('fail');
    expect(label?.detail).toContain('MOISITURIZER');
    expect(report.verdict).toBe('FAIL');
  });

  it('keeps a clean low-confidence render out of FAIL', () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      frameOf(
        [
          word('BOTANIKA', 91, BRAND),
          word('HYDRATING', 30, LABEL_ONE),
          word('MOISTURIZER', 30, LABEL_TWO),
        ],
        index,
      ),
    );
    const report = reportOf(frames);
    expect(report.checks.find((check) => check.id === 'label')?.status).not.toBe('fail');
    expect(report.verdict).not.toBe('FAIL');
  });
});
