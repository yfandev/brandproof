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
      status: 'pass',
      notes: [],
    },
  ],
  limitations: ['test limitation'],
};

describe('report export', () => {
  it('removes frame images but keeps OCR evidence', () => {
    const json = JSON.parse(reportToJson(report)) as {
      frames: Array<Record<string, unknown>>;
      verdict: string;
      schemaVersion: string;
    };
    expect(json.verdict).toBe('PASS');
    expect(json.schemaVersion).toBe('brandproof.report/1');
    expect(json.frames[0].dataUrl).toBeUndefined();
    expect(Array.isArray(json.frames[0].words)).toBe(true);
    expect(json.frames[0].text).toBe('AURELIA');
  });

  it('builds a filesystem-safe filename from the brand and timestamp', () => {
    expect(reportFilename(report)).toBe('brandproof-aurelia-2026-10-28T12-34-56-789Z.json');
  });
});
