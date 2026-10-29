import { describe, expect, it } from 'vitest';
import type { Bbox, FrameSample, OcrWord, VerificationReport, VerifyConfig } from '../../types';
import { findExtraneousReadings, isLeadingEdgeRead, normalizeText } from '../text';
import { buildReport, evaluateFrame, reportInputs } from '../verdict';

const config: VerifyConfig = {
  brand: 'BOTANIKA',
  labelText: 'HYDRATING\nMOISTURIZER',
  scene: 'luxury-studio',
  strictness: 'balanced',
  coverage: 0.6,
  sampleCount: 9,
  labelCritical: true,
  region: null,
};

function bboxAt(index: number): Bbox {
  return {
    x0: 0.1 + index * 0.1,
    y0: 0.4,
    x1: 0.1 + index * 0.1 + 0.08,
    y1: 0.46,
  };
}

function makeWords(texts: string[], confidence = 94): OcrWord[] {
  return texts.map((text, index) => ({
    text,
    normalized: normalizeText(text),
    confidence,
    bbox: bboxAt(index),
  }));
}

function makeFrames(texts: string[][]): FrameSample[] {
  const inputs = reportInputs(config);
  return texts.map((line, index) =>
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
}

function makeReportFromFrames(frames: FrameSample[]): VerificationReport {
  const inputs = reportInputs(config);
  return buildReport({
    config,
    frames,
    video: { name: 'clip.mp4', source: 'imported', duration: 4 },
    ...inputs,
    referenceSimilarity: 0.6,
  });
}

function makeReport(texts: string[][]): VerificationReport {
  return makeReportFromFrames(makeFrames(texts));
}

const cleanFrame = ['BOTANIKA', 'HYDRATING', 'MOISTURIZER'];
const duplicatedFrame = ['BOTANKA', 'BOTANIKA', 'HYDRATING', 'MOISTURIZER'];

describe('findExtraneousReadings', () => {
  const expected = ['botanika', 'hydrating', 'moisturizer'];

  it('flags a near-copy of required text as a separate word', () => {
    const readings = findExtraneousReadings(makeWords(['BOTANIKA', 'BOTANKA']), expected, 60);
    expect(readings).toHaveLength(1);
    expect(readings[0].text).toBe('BOTANKA');
    expect(readings[0].expected).toBe('botanika');
    expect(readings[0].similarity).toBeGreaterThan(0.8);
  });

  it('never flags the required words themselves', () => {
    expect(findExtraneousReadings(makeWords(cleanFrame), expected, 60)).toEqual([]);
  });

  it('ignores OCR fragments and unrelated words', () => {
    const readings = findExtraneousReadings(
      makeWords(['BOTANIKA', 'BOTANI', 'NATURAL', 'PLANT']),
      expected,
      60,
    );
    expect(readings).toEqual([]);
  });

  it('ignores a clipped leading-edge read of the same word', () => {
    const readings = findExtraneousReadings(
      makeWords(['BOTANIKA', 'TANIKA', 'UTANIKA', 'SOTANIKA']),
      expected,
      60,
    );
    expect(readings).toEqual([]);
  });

  it('ignores low-confidence reads', () => {
    const readings = findExtraneousReadings(makeWords(['BOTANKA'], 20), expected, 60);
    expect(readings).toEqual([]);
  });

  it('does nothing when no expected token is long enough to compare', () => {
    expect(findExtraneousReadings(makeWords(['BOTANKA']), ['ml'], 60)).toEqual([]);
  });
});

describe('isLeadingEdgeRead', () => {
  it('treats a lost or garbled start of the word as a partial read', () => {
    expect(isLeadingEdgeRead('botanika', 'tanika')).toBe(true);
    expect(isLeadingEdgeRead('botanika', 'utanika')).toBe(true);
    expect(isLeadingEdgeRead('botanika', 'sotanika')).toBe(true);
    expect(isLeadingEdgeRead('botanika', 'jotanika')).toBe(true);
  });

  it('does not excuse a change inside the word', () => {
    expect(isLeadingEdgeRead('botanika', 'botanka')).toBe(false);
    expect(isLeadingEdgeRead('aurelia', 'aurelio')).toBe(false);
    expect(isLeadingEdgeRead('botanika', 'botaniko')).toBe(false);
  });
});

describe('duplicated lettering in the verdict', () => {
  it('passes when only the correct brand lettering is present', () => {
    const report = makeReport(Array.from({ length: 9 }, () => cleanFrame));
    expect(report.verdict).toBe('PASS');
    expect(report.checks.find((check) => check.id === 'extra-text')?.status).toBe('pass');
  });

  it('fails when an altered copy is printed next to the correct brand in most frames', () => {
    const report = makeReport(Array.from({ length: 9 }, () => duplicatedFrame));
    const extra = report.checks.find((check) => check.id === 'extra-text');
    expect(extra?.status).toBe('fail');
    expect(extra?.critical).toBe(true);
    expect(extra?.detail).toContain('BOTANKA');
    expect(report.verdict).toBe('FAIL');
  });

  it('reviews rather than fails when the altered copy appears in a single frame', () => {
    const frames = Array.from({ length: 9 }, () => cleanFrame);
    frames[3] = duplicatedFrame;
    const report = makeReport(frames);
    expect(report.checks.find((check) => check.id === 'extra-text')?.status).toBe('review');
    expect(report.verdict).toBe('REVIEW');
  });

  it('does not treat two OCR passes over the same box as a second copy', () => {
    const shared = { x0: 0.2, y0: 0.4, x1: 0.6, y1: 0.5 };
    const inputs = reportInputs(config);
    const words: OcrWord[] = [
      { text: 'BOTANIKA', normalized: 'botanika', confidence: 94, bbox: shared },
      { text: 'BOTANKA', normalized: 'botanka', confidence: 71, bbox: shared },
      { text: 'HYDRATING', normalized: 'hydrating', confidence: 92, bbox: { x0: 0.2, y0: 0.6, x1: 0.5, y1: 0.65 } },
      { text: 'MOISTURIZER', normalized: 'moisturizer', confidence: 92, bbox: { x0: 0.2, y0: 0.7, x1: 0.5, y1: 0.75 } },
    ];
    const frame = evaluateFrame({
      index: 0,
      time: 0,
      dataUrl: '',
      width: 1280,
      height: 720,
      paletteSimilarity: 0.6,
      rawWords: words,
      text: words.map((word) => word.text).join(' '),
      config,
      threshold: inputs.threshold,
      minWordConfidence: inputs.minWordConfidence,
      brandTokens: inputs.brandTokens,
      labelTokens: inputs.labelTokens,
      region: null,
    });
    expect(frame.extraText).toEqual([]);
    const report = makeReportFromFrames(Array.from({ length: 9 }, () => frame));
    expect(report.checks.find((check) => check.id === 'extra-text')?.status).toBe('pass');
  });

  it('reviews instead of failing when the brand is only read with its first letters clipped', () => {
    const frames = Array.from({ length: 9 }, () => ['TANIKA', 'HYDRATING', 'MOISTURIZER']);
    const report = makeReport(frames);
    expect(report.verdict).toBe('REVIEW');
    const brand = report.checks.find((check) => check.id === 'brand');
    expect(brand?.status).toBe('review');
    expect(brand?.detail).toContain('partially read');
    expect(report.checks.find((check) => check.id === 'extra-text')?.status).toBe('pass');
  });

  it('records the extra reading on the frame that produced it', () => {
    const frames = makeFrames([duplicatedFrame]);
    expect(frames[0].extraText).toHaveLength(1);
    expect(frames[0].notes.some((note) => note.includes('Extra lettering'))).toBe(true);
  });
});
