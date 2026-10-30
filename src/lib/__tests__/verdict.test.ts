import { describe, expect, it } from 'vitest';
import type { FrameSample, OcrWord, VerificationReport, VerifyConfig } from '../../types';
import { normalizeText } from '../text';
import { buildReport, evaluateFrame, reportInputs } from '../verdict';

const config: VerifyConfig = {
  brand: 'Aurelia',
  labelText: 'Renewal Serum\n30 ml',
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
    confidence: 94,
    bbox: {
      x0: 0.1 + index * 0.1,
      y0: 0.4,
      x1: 0.1 + index * 0.1 + 0.08,
      y1: 0.46,
    },
  }));
}

function makeFrames(configuration: VerifyConfig, texts: string[][]): FrameSample[] {
  const inputs = reportInputs(configuration);
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
      config: configuration,
      threshold: inputs.threshold,
      minWordConfidence: inputs.minWordConfidence,
      brandTokens: inputs.brandTokens,
      labelTokens: inputs.labelTokens,
      region: null,
    }),
  );
}

function makeReport(
  configuration: VerifyConfig,
  texts: string[][],
  referenceSimilarity: number | null = 0.6,
): VerificationReport {
  const inputs = reportInputs(configuration);
  return buildReport({
    config: configuration,
    frames: makeFrames(configuration, texts),
    video: { name: 'clip.mp4', source: 'imported', duration: 4 },
    ...inputs,
    referenceSimilarity,
  });
}

const fullFrame = ['AURELIA', 'RENEWAL', 'SERUM', '30', 'ML'];
const nineFrames = Array.from({ length: 9 }, () => fullFrame);

describe('verdict aggregation', () => {
  it('passes when brand and label text are present in enough readable frames', () => {
    const report = makeReport(config, nineFrames);
    expect(report.verdict).toBe('PASS');
    expect(report.metrics.brandRecall).toBe(1);
    expect(report.checks.find((check) => check.id === 'label')?.status).toBe('pass');
  });

  it('skips the label check and still passes when only a brand is configured', () => {
    const report = makeReport({ ...config, labelText: '' }, nineFrames);
    expect(report.verdict).toBe('PASS');
    expect(report.checks.find((check) => check.id === 'label')?.status).toBe('skipped');
  });

  it('fails when text is readable but the brand never appears', () => {
    const frames = Array.from({ length: 9 }, () => [
      'BOTANICA',
      'RENEWAL',
      'SERUM',
      '30',
      'ML',
    ]);
    const report = makeReport(config, frames);
    expect(report.verdict).toBe('FAIL');
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('fail');
  });

  it('fails when the brand is repeatedly read as a near-miss', () => {
    const frames = Array.from({ length: 9 }, () => [
      'AURELJA',
      'RENEWAL',
      'SERUM',
      '30',
      'ML',
    ]);
    const report = makeReport(config, frames);
    expect(report.verdict).toBe('FAIL');
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('fail');
    expect(report.frames[0].brand[0].status).toBe('near');
  });

  it('reviews when no frame is readable', () => {
    const report = makeReport(config, Array.from({ length: 9 }, () => []));
    expect(report.verdict).toBe('REVIEW');
    expect(report.metrics.readableFrames).toBe(0);
    expect(report.checks.find((check) => check.id === 'legibility')?.status).toBe('fail');
  });

  it('passes when the brand is read clearly even below the coverage target', () => {
    // Five of nine readable frames carry the brand at confidence 94: 55%, under
    // the 60% target. A person can plainly read the brand, so coverage is a
    // diagnostic and the readable frames are not held to a fixed share.
    const frames = Array.from({ length: 9 }, (_, index) =>
      index < 5 ? fullFrame : ['BOTANICA', 'RENEWAL', 'SERUM', '30', 'ML'],
    );
    const report = makeReport(config, frames);
    expect(report.metrics.brandRecall).toBeCloseTo(5 / 9, 3);
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('pass');
    expect(report.verdict).toBe('PASS');
  });

  it('reviews when the brand was read clearly in only one frame', () => {
    const frames = Array.from({ length: 9 }, (_, index) =>
      index === 0 ? fullFrame : ['BOTANICA', 'RENEWAL', 'SERUM', '30', 'ML'],
    );
    const report = makeReport(config, frames);
    expect(report.verdict).toBe('REVIEW');
    expect(report.checks.find((check) => check.id === 'brand')?.status).toBe('review');
  });

  it('reviews when expected label lines are simply not detected', () => {
    const frames = Array.from({ length: 9 }, () => [
      'AURELIA',
      'HYDRATING',
      'GEL',
      '30',
      'ML',
    ]);
    const report = makeReport(config, frames);
    expect(report.verdict).toBe('REVIEW');
    expect(report.checks.find((check) => check.id === 'label')?.status).toBe('review');
    expect(
      report.tokenEvidence.find((evidence) => evidence.token === 'renewal')?.finding,
    ).toBe('not-detected');
  });

  it('fails when a label token is repeatedly read as a near miss', () => {
    const frames = Array.from({ length: 9 }, () => [
      'AURELIA',
      'RENEWAI',
      'SERUM',
      '30',
      'ML',
    ]);
    const report = makeReport(config, frames);
    expect(report.verdict).toBe('FAIL');
    expect(report.checks.find((check) => check.id === 'label')?.status).toBe('fail');
    expect(
      report.tokenEvidence.find((evidence) => evidence.token === 'renewal')?.finding,
    ).toBe('visibly-distorted');
  });

  it('does not fail on a single near reading', () => {
    const frames = Array.from({ length: 9 }, (_, index) =>
      index === 0
        ? ['AURELIA', 'RENEWAI', 'SERUM', '30', 'ML']
        : ['AURELIA', 'HYDRATING', 'GEL', '30', 'ML'],
    );
    const report = makeReport(config, frames);
    expect(report.verdict).toBe('REVIEW');
    expect(report.checks.find((check) => check.id === 'label')?.status).toBe('review');
    expect(
      report.tokenEvidence.find((evidence) => evidence.token === 'renewal')?.finding,
    ).toBe('insufficient-evidence');
  });

  it('downgrades a non-critical distorted label to REVIEW', () => {
    const frames = Array.from({ length: 9 }, () => [
      'AURELIA',
      'RENEWAI',
      'SERUM',
      '30',
      'ML',
    ]);
    const report = makeReport({ ...config, labelCritical: false }, frames);
    expect(report.verdict).toBe('REVIEW');
    expect(report.checks.find((check) => check.id === 'label')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'label')?.critical).toBe(false);
  });

  it('keeps palette evidence advisory and never fails on colour alone', () => {
    const report = makeReport(config, nineFrames, 0.05);
    expect(report.verdict).toBe('PASS');
    const palette = report.checks.find((check) => check.id === 'palette');
    expect(palette?.status).toBe('review');
    expect(palette?.critical).toBe(false);
  });

  it('marks frames as unreadable when OCR text is too weak', () => {
    const inputs = reportInputs(config);
    const frame = evaluateFrame({
      index: 0,
      time: 0,
      dataUrl: '',
      width: 1280,
      height: 720,
      paletteSimilarity: null,
      rawWords: makeWords(['AURELIA']).map((entry) => ({ ...entry, confidence: 12 })),
      text: 'AURELIA',
      config,
      threshold: inputs.threshold,
      minWordConfidence: inputs.minWordConfidence,
      brandTokens: inputs.brandTokens,
      labelTokens: inputs.labelTokens,
      region: null,
    });
    expect(frame.legible).toBe(false);
    expect(frame.status).toBe('unreadable');
    expect(frame.brand[0].status).toBe('unreadable');
  });
});
