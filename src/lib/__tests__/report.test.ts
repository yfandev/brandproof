import { describe, expect, it } from 'vitest';
import type { VerificationReport } from '../../types';
import { reportFilename, reportToJson } from '../report';

const report: VerificationReport = {
  app: 'BrandProof',
  schemaVersion: 'brandproof.report/1',
  createdAt: '2026-10-28T12:34:56.789Z',
  verdict: 'PASS',
  headline: 'Brand integrity holds',
  summary: 'Test summary',
  config: {
    brand: 'Aurelia',
    labelText: 'Renewal Serum',
    scene: 'luxury-studio',
    strictness: 'balanced',
    coverage: 0.6,
    sampleCount: 2,
    labelCritical: true,
    region: null,
    threshold: 0.87,
    minWordConfidence: 45,
    brandTokens: ['aurelia'],
    labelTokens: ['renewal', 'serum'],
  },
  video: { name: 'clip.mp4', source: 'imported', duration: 4 },
  checks: [],
  metrics: {
    sampledFrames: 2,
    readableFrames: 2,
    requiredReadableFrames: 2,
    brandHits: 2,
    brandRecall: 1,
    labelHits: 2,
    labelRecall: 1,
    meanConfidence: 90,
    readableFraction: 1,
    paletteSimilarity: 0.6,
    coverageTarget: 0.6,
  },
  tokenEvidence: [],
  frames: [
    {
      index: 0,
      time: 0.2,
      dataUrl: 'data:image/jpeg;base64,abc',
      width: 1280,
      height: 720,
      paletteSimilarity: 0.6,
      words: [
        {
          text: 'AURELIA',
          normalized: 'aurelia',
          confidence: 95,
          bbox: { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.3 },
        },
      ],
      text: 'AURELIA',
      meanConfidence: 95,
      legible: true,
      brand: [],
      label: [],
      extraText: [],
      status: 'pass',
      notes: [],
      ocrPasses: [
        {
          id: 'crop-original-block',
          label: 'Label crop · original · block',
          psm: 6,
          variant: 'original',
          wordCount: 1,
          confidence: 95,
        },
      ],
      ocrRegion: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
      ocrRegionSource: 'auto',
    },
  ],
  diagnostics: {
    capture: { width: 1280, height: 720, requestedFrames: 2, capturedFrames: 1 },
    ocr: {
      engine: 'Tesseract.js 7 (LSTM)',
      passesPerFrame: [1],
      totalPasses: 1,
      totalWords: 1,
      regionSources: ['auto'],
    },
  },
  limitations: ['test limitation'],
};

describe('report export', () => {
  it('removes frame images but keeps OCR evidence', () => {
    const json = JSON.parse(reportToJson(report)) as {
      frames: Array<Record<string, unknown>>;
      verdict: string;
      schemaVersion: string;
      diagnostics: { ocr: { totalPasses: number } };
    };
    expect(json.verdict).toBe('PASS');
    expect(json.schemaVersion).toBe('brandproof.report/1');
    expect(json.frames[0].dataUrl).toBeUndefined();
    expect(Array.isArray(json.frames[0].words)).toBe(true);
    expect(json.frames[0].text).toBe('AURELIA');
    expect(Array.isArray(json.frames[0].ocrPasses)).toBe(true);
    expect((json.diagnostics as { ocr: { totalPasses: number } }).ocr.totalPasses).toBe(1);
  });

  it('builds a filesystem-safe filename from the brand and timestamp', () => {
    expect(reportFilename(report)).toBe('brandproof-aurelia-2026-10-28T12-34-56-789Z.json');
  });
});
