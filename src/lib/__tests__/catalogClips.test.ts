import { describe, expect, it } from 'vitest';
import type { VerificationReport, VerifyConfig } from '../../types';
import { createProductJob, type CatalogRun, type CatalogRunConfig } from '../catalog';
import { runCatalog, type CatalogRuntimeProduct } from '../catalogRunner';

const CONFIG: CatalogRunConfig = {
  concurrency: 1,
  budgetCredits: 12,
  maxAttempts: 3,
  scene: 'luxury-studio',
  strictness: 'balanced',
  sampleCount: 6,
  coverage: 0.6,
  labelCritical: true,
};

function report(verdict: VerificationReport['verdict']): VerificationReport {
  const config: VerifyConfig = {
    brand: 'BOTANIKA',
    labelText: 'HYDRATING',
    scene: 'luxury-studio',
    strictness: 'balanced',
    coverage: 0.6,
    sampleCount: 6,
    labelCritical: true,
    region: null,
  };
  return {
    app: 'BrandProof',
    schemaVersion: 'test',
    createdAt: '2026-10-29T00:00:00.000Z',
    verdict,
    headline: `${verdict} headline`,
    summary: 'summary',
    config: { ...config, threshold: 0.6, minWordConfidence: 40, brandTokens: ['botanika'], labelTokens: ['hydrating'] },
    video: { name: 'clip.mp4', source: 'generated', duration: 4 },
    checks: [],
    metrics: {
      sampledFrames: 6,
      readableFrames: 6,
      requiredReadableFrames: 3,
      brandHits: 6,
      brandRecall: 1,
      labelHits: 6,
      labelRecall: 1,
      meanConfidence: 80,
      readableFraction: 1,
      paletteSimilarity: null,
      coverageTarget: 0.6,
    },
    tokenEvidence: [],
    frames: [],
    limitations: [],
  };
}

function runOf(): CatalogRun {
  return {
    id: 'run_clips',
    createdAt: '2026-10-29T00:00:00.000Z',
    finishedAt: null,
    status: 'running',
    config: CONFIG,
    serverBudgetCredits: 12,
    products: [
      createProductJob({
        id: 'p1',
        name: 'Bottle',
        brand: 'BOTANIKA',
        labelText: 'HYDRATING',
        instructions: '',
      }),
    ],
  };
}

describe('catalog clip retention', () => {
  it('hands the UI a clip for every attempt, not only the last one', async () => {
    const rate = 3;
    const run = runOf();
    const runtime = new Map<string, CatalogRuntimeProduct>([
      [
        'p1',
        {
          image: new File([new Uint8Array([1])], 'bottle.png', { type: 'image/png' }),
          reference: null,
          basePrompt: 'base',
        },
      ],
    ]);

    const captured: Array<{ attemptId: string; attemptIndex: number; filename: string }> = [];
    let verified = 0;

    await runCatalog({
      run,
      runtime,
      sleep: async () => undefined,
      deps: {
        reserve: async () => ({ granted: true, reason: null, credits: 1.15 }),
        settle: async () => undefined,
        generate: async ({ prompt, attemptId }) => {
          void prompt;
          void attemptId;
          verified += 1;
          return {
            blob: new Blob([new Uint8Array([verified])], { type: 'video/mp4' }),
            filename: `clip-${verified}.mp4`,
            jobId: `job-${verified}`,
          };
        },
        verify: async () => (verified < rate ? report('FAIL') : report('PASS')),
        onClip: ({ attemptId, attemptIndex, filename }) => {
          captured.push({ attemptId, attemptIndex, filename });
        },
      },
    });

    expect(captured).toHaveLength(3);
    expect(new Set(captured.map((clip) => clip.attemptId)).size).toBe(3);
    expect(captured.map((clip) => clip.attemptIndex)).toEqual([1, 2, 3]);
    expect(captured.map((clip) => clip.filename)).toEqual(['clip-1.mp4', 'clip-2.mp4', 'clip-3.mp4']);
    expect(run.products[0].status).toBe('approved');
  });

  it('keeps the first clip available when the first attempt fails and the second passes', async () => {
    const run = runOf();
    const runtime = new Map<string, CatalogRuntimeProduct>([
      [
        'p1',
        {
          image: new File([new Uint8Array([1])], 'bottle.png', { type: 'image/png' }),
          reference: null,
          basePrompt: 'base',
        },
      ],
    ]);

    const captured: string[] = [];
    let attempts = 0;

    await runCatalog({
      run,
      runtime,
      sleep: async () => undefined,
      deps: {
        reserve: async () => ({ granted: true, reason: null, credits: 1.15 }),
        settle: async () => undefined,
        generate: async () => {
          attempts += 1;
          return {
            blob: new Blob([new Uint8Array([attempts])], { type: 'video/mp4' }),
            filename: `clip-${attempts}.mp4`,
            jobId: `job-${attempts}`,
          };
        },
        verify: async () => (attempts === 1 ? report('FAIL') : report('PASS')),
        onClip: ({ filename }) => {
          captured.push(filename);
        },
      },
    });

    expect(captured).toEqual(['clip-1.mp4', 'clip-2.mp4']);
  });
});
