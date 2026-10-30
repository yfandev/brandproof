import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS_PER_PRODUCT,
  adjustmentFromEvidence,
  buildCatalogPrompt,
  computeMetrics,
  createProductJob,
  emptyDraft,
  isTerminal,
  restoreFromSnapshot,
  runToCsv,
  runToExportJson,
  toSnapshot,
  validateDrafts,
  type CatalogRun,
  type CompactEvidence,
} from '../catalog';

function run(overrides: Partial<CatalogRun> = {}): CatalogRun {
  const product = createProductJob({
    id: 'p1',
    name: 'Botanika',
    brand: 'BOTANIKA',
    labelText: 'HYDRATING\nMOISTURIZER',
    instructions: '',
  });
  product.status = 'approved';
  product.approvedAttemptId = 'att1';
  product.attempts = [
    {
      id: 'att1',
      index: 1,
      prompt: 'prompt',
      adjustment: null,
      adjustmentReason: null,
      jobId: 'job-1',
      startedAt: '2026-10-29T00:00:00.000Z',
      finishedAt: '2026-10-29T00:01:00.000Z',
      verdict: 'PASS',
      headline: 'Label text verified',
      evidence: null,
      estimateCredits: 1.15,
      error: null,
      videoName: 'clip.mp4',
      reservationState: 'settled',
    },
  ];
  return {
    id: 'run_test',
    createdAt: '2026-10-29T00:00:00.000Z',
    finishedAt: '2026-10-29T00:02:00.000Z',
    status: 'complete',
    config: {
      concurrency: 3,
      budgetCredits: 12,
      maxAttempts: MAX_ATTEMPTS_PER_PRODUCT,
      scene: 'luxury-studio',
      strictness: 'balanced',
      sampleCount: 12,
      coverage: 0.6,
      labelCritical: true,
    },
    serverBudgetCredits: 12,
    products: [product],
    ...overrides,
  };
}

describe('catalog validation', () => {
  it('reports every missing required field', () => {
    const problems = validateDrafts([emptyDraft('p1')], () => false);
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join(' ')).toContain('brand name');
    expect(problems.join(' ')).toContain('product photo');
  });

  it('does not require label lines, only the brand', () => {
    const problems = validateDrafts(
      [{ id: 'p1', name: 'A', brand: 'B', labelText: '', instructions: '' }],
      () => true,
    );
    expect(problems).toEqual([]);
  });

  it('accepts a complete row', () => {
    const problems = validateDrafts(
      [{ id: 'p1', name: 'A', brand: 'B', labelText: 'X', instructions: '' }],
      () => true,
    );
    expect(problems).toEqual([]);
  });
});

describe('catalog prompts', () => {
  it('adds product direction to the studio prompt', () => {
    const prompt = buildCatalogPrompt(
      { id: 'p1', name: 'A', brand: 'BOTANIKA', labelText: 'HYDRATING', instructions: 'Front label only' },
      run().config,
    );
    expect(prompt).toContain('BOTANIKA');
    expect(prompt).toContain('Front label only');
  });

  it('derives a revision from the observed token findings only', () => {
    const evidence: CompactEvidence = {
      verdict: 'FAIL',
      headline: 'Required text missing',
      summary: '',
      checks: [],
      tokenEvidence: [
        {
          token: 'HYDRATING',
          kind: 'label',
          finding: 'not-detected',
          bestReading: null,
          bestSimilarity: 0.3,
          hits: 0,
          missing: 5,
          unreadable: 0,
        },
      ],
      frames: [],
      metrics: {
        sampledFrames: 5,
        readableFrames: 1,
        brandHits: 0,
        labelHits: 0,
        meanConfidence: 20,
        readableFraction: 0.2,
      },
      limitations: [],
    };
    const adjustment = adjustmentFromEvidence(evidence, 2);
    expect(adjustment.adjustment).toContain('attempt 2');
    expect(adjustment.adjustment).toContain('facing the camera');
    expect(adjustment.reason).toContain('HYDRATING');
  });

  it('only asks to keep the brand when the previous clip actually read it', () => {
    const evidence: CompactEvidence = {
      verdict: 'REVIEW',
      headline: 'Needs a human check',
      summary: '',
      checks: [],
      tokenEvidence: [
        {
          token: 'BOTANIKA',
          kind: 'brand',
          finding: 'verified',
          bestReading: 'BOTANIKA',
          bestSimilarity: 0.97,
          hits: 8,
          missing: 0,
          unreadable: 0,
        },
        {
          token: 'HYDRATING',
          kind: 'label',
          finding: 'not-detected',
          bestReading: null,
          bestSimilarity: 0.4,
          hits: 0,
          missing: 6,
          unreadable: 0,
        },
      ],
      frames: [],
      metrics: {
        sampledFrames: 12,
        readableFrames: 11,
        brandHits: 9,
        labelHits: 0,
        meanConfidence: 78,
        readableFraction: 0.9,
      },
      limitations: [],
    };

    const adjustment = adjustmentFromEvidence(evidence, 2);
    expect(adjustment.adjustment).toContain(
      'Keep the brand name and the packaging exactly as they already appear',
    );
    expect(adjustment.adjustment).not.toContain('must read exactly');
  });

  it('asks for the brand to be corrected when the previous clip did not read it', () => {
    const evidence: CompactEvidence = {
      verdict: 'FAIL',
      headline: 'Fidelity break detected',
      summary: '',
      checks: [],
      tokenEvidence: [
        {
          token: 'BOTANIKA',
          kind: 'brand',
          finding: 'not-detected',
          bestReading: 'BOTANKA',
          bestSimilarity: 0.71,
          hits: 0,
          missing: 9,
          unreadable: 0,
        },
        {
          token: 'HYDRATING',
          kind: 'label',
          finding: 'not-detected',
          bestReading: null,
          bestSimilarity: 0.4,
          hits: 0,
          missing: 6,
          unreadable: 0,
        },
      ],
      frames: [],
      metrics: {
        sampledFrames: 12,
        readableFrames: 10,
        brandHits: 0,
        labelHits: 0,
        meanConfidence: 70,
        readableFraction: 0.8,
      },
      limitations: [],
    };

    const adjustment = adjustmentFromEvidence(evidence, 2);
    expect(adjustment.adjustment).toContain('must read exactly "BOTANIKA"');
    expect(adjustment.adjustment).not.toContain(
      'Keep the brand name and the packaging exactly as they already appear',
    );
    expect(adjustment.reason).toContain('Brand was not verified');
  });

  it('never claims a specific miss when no evidence exists', () => {
    const adjustment = adjustmentFromEvidence(null, 2);
    expect(adjustment.adjustment).toContain('Increase label legibility');
    expect(adjustment.reason).toContain('No token-level evidence');
  });
});

describe('catalog metrics', () => {
  it('counts approvals, attempts and estimates separately', () => {
    const metrics = computeMetrics(run());
    expect(metrics.submitted).toBe(1);
    expect(metrics.approved).toBe(1);
    expect(metrics.attempts).toBe(1);
    expect(metrics.generatedClips).toBe(1);
    expect(metrics.estimatedCredits).toBeCloseTo(1.15);
    expect(metrics.actualCredits).toBeNull();
    expect(metrics.approvalRate).toBe(1);
    expect(metrics.costPerApprovedClip).toBeCloseTo(1.15);
  });

  it('reports N/A for cost per approved clip when nothing is approved', () => {
    const base = run();
    const product = base.products[0];
    product.status = 'needs-review';
    product.approvedAttemptId = null;
    const metrics = computeMetrics({ ...base, products: [product] });
    expect(metrics.approved).toBe(0);
    expect(metrics.approvalRate).toBe(0);
    expect(metrics.costPerApprovedClip).toBeNull();
  });

  it('never counts REVIEW, errors or budget-limited products as approvals', () => {
    const base = run();
    const second = { ...base.products[0], id: 'p2', status: 'needs-review' as const };
    const third = { ...base.products[0], id: 'p3', status: 'budget-limited' as const };
    const metrics = computeMetrics({ ...base, products: [base.products[0], second, third] });
    expect(metrics.approved).toBe(1);
    expect(metrics.needsReview).toBe(1);
    expect(metrics.budgetLimited).toBe(1);
    expect(metrics.approvalRate).toBeCloseTo(1 / 3);
  });
});

describe('catalog exports', () => {
  it('writes one CSV row per product with honest blank actual cost', () => {
    const csv = runToCsv(run());
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('estimated_credits');
    expect(lines[0]).toContain('actual_credits');
    expect(lines[1]).toContain('approved');
  });

  it('exports run configuration, metrics and the cost caveat', () => {
    const json = JSON.parse(runToExportJson(run(), new Map())) as {
      run: { config: { concurrency: number } };
      metrics: { approved: number };
      cost: { source: string; actualCredits: null };
      products: Array<{ report?: unknown }>;
    };
    expect(json.run.config.concurrency).toBe(3);
    expect(json.metrics.approved).toBe(1);
    expect(json.cost.source).toBe('estimate');
    expect(json.cost.actualCredits).toBeNull();
    expect(json.products[0].report).toBeUndefined();
  });
});

describe('catalog snapshot restore', () => {
  it('marks unfinished products interrupted instead of reporting success', () => {
    const base = run();
    const product = base.products[0];
    product.status = 'generating';
    product.finishedAt = null;
    product.attempts[0].reservationState = 'granted';
    product.attempts[0].finishedAt = null;

    const restored = restoreFromSnapshot(toSnapshot({ ...base, products: [product] }));
    expect(restored.products[0].status).toBe('interrupted');
    expect(restored.products[0].message).toContain('No new generation was submitted');
    expect(isTerminal(restored.products[0].status)).toBe(true);
    expect(restored.status).toBe('complete');
  });
});
