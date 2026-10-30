import { describe, expect, it } from 'vitest';
import type { FrameSample, OcrWord, VerificationReport, VerifyConfig } from '../../types';
import { normalizeText } from '../text';
import { buildReport, evaluateFrame, reportInputs } from '../verdict';

const config: VerifyConfig = {
  brand: 'Aurelia',
  labelText: 'Renewal Serum',
  scene: 'luxury-studio',
  strictness: 'balanced',
  coverage: 0.6,
  sampleCount: 9,
  labelCritical: true,
  region: null,
};

function makeWords(texts: string[]): OcrWord[] {
  return texts.map((text, index) => ({
    text,
    normalized: normalizeText(text),
    confidence: 92,
    bbox: {
      x0: 0.02 + (index % 8) * 0.11,
      y0: 0.02 + Math.floor(index / 8) * 0.03,
      x1: 0.02 + (index % 8) * 0.11 + 0.08,
      y1: 0.02 + Math.floor(index / 8) * 0.03 + 0.02,
    },
  }));
}

function report(texts: string[][]): VerificationReport {
  const inputs = reportInputs(config);
  const frames: FrameSample[] = texts.map((line, index) =>
    evaluateFrame({
      index,
      time: index * 0.4,
      dataUrl: '',
      width: 1280,
      height: 720,
      paletteSimilarity: 0.6,
      rawWords: makeWords(line),
      text: line.join(' '),
      config,
      threshold: inputs.threshold,
      minWordConfidence: inputs.minWordConfidence,
      brandTokens: inputs.brandTokens,
      labelTokens: inputs.labelTokens,
      region: null,
    }),
  );

  return buildReport({
    config,
    frames,
    video: { name: 'clip.mp4', source: 'imported', duration: 4 },
    ...inputs,
    referenceSimilarity: 0.6,
  });
}

const cleanFrame = ['AURELIA', 'RENEWAL', 'SERUM'];

/** A page of pseudo-text: the label words are right, the surface is covered. */
const newspaperFrame = [
  'AURELIA',
  'RENEWAL',
  'SERUM',
  ...Array.from({ length: 40 }, (_, index) => `Zqxjv${String.fromCharCode(97 + (index % 26))}wmp`),
];

describe('invented lettering on the packaging', () => {
  it('fails a clip whose labels are correct but whose frames are covered in text', () => {
    const result = report(Array.from({ length: 9 }, () => newspaperFrame));
    expect(result.checks.find((check) => check.id === 'lettering-load')?.status).toBe('fail');
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find((check) => check.id === 'lettering-load')?.detail).toContain(
      'invented text covering the packaging',
    );
  });

  it('leaves a clean product video alone', () => {
    const result = report(Array.from({ length: 9 }, () => cleanFrame));
    expect(result.checks.find((check) => check.id === 'lettering-load')?.status).toBe('pass');
    expect(result.verdict).toBe('PASS');
  });

  it('asks for a human look when only one frame is overloaded', () => {
    const texts = Array.from({ length: 9 }, (_, index) =>
      index === 0 ? newspaperFrame : cleanFrame,
    );
    const result = report(texts);
    expect(result.checks.find((check) => check.id === 'lettering-load')?.status).toBe('review');
    expect(result.verdict).toBe('REVIEW');
  });
});
