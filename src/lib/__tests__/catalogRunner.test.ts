import { describe, expect, it } from 'vitest';
import type { VerificationReport } from '../../types';
import {
  createProductJob,
  type CatalogRun,
  type CatalogRunConfig,
  type CatalogProductJob,
} from '../catalog';
import { runCatalog, type CatalogRunnerDeps, type CatalogRuntimeProduct } from '../catalogRunner';

const CONFIG: CatalogRunConfig = {
  concurrency: 3,
  budgetCredits: 12,
  maxAttempts: 3,
  scene: 'luxury-studio',
  strictness: 'balanced',
  sampleCount: 6,
  coverage: 0.6,
  labelCritical: true,
};

function product(id: string, name = id): CatalogProductJob {
  return createProductJob({
    id,
    name,
    brand: 'BOTANIKA',
    labelText: 'HYDRATING\nMOISTURIZER',
    instructions: '',
  });
}

function report(verdict: VerificationReport['verdict'], token = 'HYDRATING'): VerificationReport {
  return {
    app: 'BrandProof',
    schemaVersion: 'test',
    createdAt: '2026-10-29T00:00:00.000Z',
    verdict,
    headline: `${verdict} headline`,
    summary: 'summary',
    config: {
      brand: 'BOTANIKA',
      labelText: 'HYDRATING',
      scene: 'luxury-studio',
      strictness: 'balanced',
      coverage: 0.6,
      sampleCount: 6,
      labelCritical: true,
      region: null,
      threshold: 0.6,
      minWordConfidence: 40,
      brandTokens: ['BOTANIKA'],
      labelTokens: [token],
    },
    video: { name: 'clip.mp4', source: 'generated', duration: 4 },
    checks: [
      {
        id: 'label',
        title: 'Required label text',
        status: verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : 'review',
        critical: true,
        detail: 'detail',
        metric: 'metric',
      },
    ],
    metrics: {
      sampledFrames: 6,
      readableFrames: 4,
      requiredReadableFrames: 3,
      brandHits: 4,
      brandRecall: 0.7,
      labelHits: 2,
      labelRecall: 0.4,
      meanConfidence: 80,
      readableFraction: 0.6,
      paletteSimilarity: null,
      coverageTarget: 0.6,
    },
    tokenEvidence: [
      {
        token,
        kind: 'label',
        hits: verdict === 'PASS' ? 6 : 0,
        near: 0,
        missing: verdict === 'PASS' ? 0 : 6,
        unreadable: 0,
        bestReading: verdict === 'PASS' ? token : null,
        bestSimilarity: verdict === 'PASS' ? 0.95 : 0.2,
        bestConfidence: verdict === 'PASS' ? 88 : null,
        finding: verdict === 'PASS' ? 'verified' : verdict === 'FAIL' ? 'not-detected' : 'unreadable',
      },
    ],
    frames: [],
    limitations: [],
  };
}

function runtimeOf(jobs: CatalogProductJob[]) {
  const runtime = new Map<string, CatalogRuntimeProduct>();
  jobs.forEach((job) => {
    runtime.set(job.id, {
      image: new File([new Uint8Array([1])], `${job.id}.png`, { type: 'image/png' }),
      reference: null,
      basePrompt: `base prompt for ${job.name}`,
    });
  });
  return runtime;
}

function runOf(products: CatalogProductJob[], concurrency = CONFIG.concurrency): CatalogRun {
  return {
    id: 'run_test',
    createdAt: '2026-10-29T00:00:00.000Z',
    finishedAt: null,
    status: 'running',
    config: { ...CONFIG, concurrency },
    serverBudgetCredits: 12,
    products,
  };
}

interface Recorder {
  generateCalls: Array<{ productId: string; prompt: string; imageName: string }>;
  settleCalls: Array<{ attemptId: string; outcome: 'used' | 'released' }>;
  reserveCalls: number;
  maxConcurrent: number;
}

function depsFor(
  options: {
    verify?: (job: CatalogProductJob, attempt: number) => VerificationReport;
    generate?: (job: CatalogProductJob, attempt: number) => Promise<void>;
    budget?: number;
    onClip?: (productId: string) => void;
    /** Emitted once from inside generate, like a live Comfy job update. */
    progressMessage?: string;
  } = {},
): { deps: CatalogRunnerDeps; recorder: Recorder; budgetLeft: { value: number } } {
  const recorder: Recorder = {
    generateCalls: [],
    settleCalls: [],
    reserveCalls: 0,
    maxConcurrent: 0,
  };
  let inFlight = 0;
  const budgetLeft = { value: options.budget ?? 99 };

  const deps: CatalogRunnerDeps = {
    async reserve({ runId, attemptId, productId }) {
      recorder.reserveCalls += 1;
      if (budgetLeft.value < 1) return { granted: false, reason: 'run_budget', credits: 0 };
      budgetLeft.value -= 1;
      void runId;
      void attemptId;
      void productId;
      return { granted: true, reason: null, credits: 1 };
    },
    async settle({ attemptId, outcome }) {
      recorder.settleCalls.push({ attemptId, outcome });
    },
    async generate({ image, prompt, attemptId, onJobId, onProgress }) {
      inFlight += 1;
      recorder.maxConcurrent = Math.max(recorder.maxConcurrent, inFlight);
      const job = { name: prompt.match(/base prompt for (.+)$/)?.[1] ?? 'unknown' };
      recorder.generateCalls.push({ productId: job.name, prompt, imageName: image.name });
      onJobId(`job-${attemptId}`);
      if (options.progressMessage) onProgress?.(options.progressMessage);
      try {
        const attemptIndex = Number(prompt.match(/attempt (\d+)/i)?.[1] ?? 0);
        if (options.generate) {
          const match = options.generate as unknown as (
            job: { name: string },
            attempt: number,
          ) => Promise<void>;
          await match({ name: job.name }, attemptIndex);
        }
        return {
          blob: new File([new Uint8Array([0, 1])], 'clip.mp4', { type: 'video/mp4' }),
          filename: 'clip.mp4',
          jobId: 'job-1',
        };
      } finally {
        inFlight -= 1;
      }
    },
    async verify({ job }) {
      const attempt = job.attempts.length;
      return options.verify ? options.verify(job, attempt) : report('PASS');
    },
    onClip: ({ productId }) => options.onClip?.(productId),
  };

  return { deps, recorder, budgetLeft };
}

describe('catalog runner', () => {
  it('approves on attempt 1 and never regenerates', async () => {
    const job = product('p1');
    const { deps, recorder } = depsFor({ verify: () => report('PASS') });
    await runCatalog({ run: runOf([job]), runtime: runtimeOf([job]), deps });

    expect(job.status).toBe('approved');
    expect(job.attempts).toHaveLength(1);
    expect(recorder.generateCalls).toHaveLength(1);
    expect(recorder.settleCalls).toEqual([{ attemptId: job.attempts[0].id, outcome: 'used' }]);
  });

  it('approves only after a real PASS following a FAIL, and records the revision', async () => {
    const job = product('p1');
    const { deps } = depsFor({
      verify: (_job, attempt) => (attempt === 1 ? report('FAIL') : report('PASS')),
    });
    await runCatalog({ run: runOf([job]), runtime: runtimeOf([job]), deps });

    expect(job.status).toBe('approved');
    expect(job.attempts).toHaveLength(2);
    expect(job.attempts[0].verdict).toBe('FAIL');
    expect(job.attempts[1].verdict).toBe('PASS');
    expect(job.attempts[1].adjustment).toContain('Revision for attempt 2');
    expect(job.attempts[1].prompt).toContain('Revision for attempt 2');
    expect(job.approvedAttemptId).toBe(job.attempts[1].id);
  });

  it('stops after three attempts and needs human review', async () => {
    const job = product('p1');
    const { deps, recorder } = depsFor({ verify: () => report('FAIL') });
    await runCatalog({ run: runOf([job]), runtime: runtimeOf([job]), deps });

    expect(job.status).toBe('needs-review');
    expect(job.attempts).toHaveLength(3);
    expect(recorder.generateCalls).toHaveLength(3);
    expect(job.approvedAttemptId).toBeNull();
  });

  it('never treats REVIEW as approval', async () => {
    const job = product('p1');
    const { deps } = depsFor({ verify: () => report('REVIEW') });
    await runCatalog({ run: runOf([job]), runtime: runtimeOf([job]), deps });

    expect(job.status).toBe('needs-review');
    expect(job.attempts.every((attempt) => attempt.verdict === 'REVIEW')).toBe(true);
    expect(job.approvedAttemptId).toBeNull();
  });

  it('stops a product at the budget with no generation started', async () => {
    const job = product('p1');
    const { deps, recorder } = depsFor({ budget: 0 });
    await runCatalog({ run: runOf([job]), runtime: runtimeOf([job]), deps });

    expect(job.status).toBe('budget-limited');
    expect(recorder.generateCalls).toHaveLength(0);
    expect(job.attempts[0].reservationState).toBe('denied');
  });

  it('starts products concurrently and respects the limit', async () => {
    const jobs = [product('a'), product('b'), product('c'), product('d')];
    const gate: Array<() => void> = [];
    const { deps, recorder } = depsFor({
      verify: () => report('PASS'),
      generate: () =>
        new Promise<void>((resolve) => {
          gate.push(resolve);
        }),
    });

    const pending = runCatalog({
      run: runOf(jobs, 2),
      runtime: runtimeOf(jobs),
      deps,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gate.length).toBe(2);

    while (gate.length > 0) {
      const next = gate.shift();
      next?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await pending;

    expect(recorder.maxConcurrent).toBeLessThanOrEqual(2);
    expect(recorder.generateCalls).toHaveLength(4);
    expect(jobs.every((job) => job.status === 'approved')).toBe(true);
  });

  it('does not let one slow product block a fast one', async () => {
    const slow = product('slow');
    const fast = product('fast');
    const order: string[] = [];
    const { deps } = depsFor({
      verify: (job) => {
        order.push(job.id);
        return report('PASS');
      },
      generate: (job) =>
        job.name === 'slow'
          ? new Promise((resolve) => setTimeout(resolve, 80))
          : Promise.resolve(),
    });

    await runCatalog({
      run: runOf([slow, fast], 2),
      runtime: runtimeOf([slow, fast]),
      deps,
    });

    expect(order[0]).toBe('fast');
    expect(fast.status).toBe('approved');
    expect(slow.status).toBe('approved');
  });

  it('keeps the catalog running when one product errors', async () => {
    const broken = product('broken');
    const healthy = product('healthy');
    const { deps } = depsFor({
      generate: (job) => {
        if (job.name === 'broken') return Promise.reject(new Error('Comfy Cloud job failed.'));
        return Promise.resolve();
      },
      verify: () => report('PASS'),
    });

    await runCatalog({
      run: runOf([broken, healthy], 2),
      runtime: runtimeOf([broken, healthy]),
      deps,
    });

    expect(broken.status).toBe('error');
    expect(broken.attempts).toHaveLength(3);
    expect(healthy.status).toBe('approved');
  });

  it('marks a product without a photo as an error instead of pretending it ran', async () => {
    const job = product('p1');
    const { deps, recorder } = depsFor();
    await runCatalog({ run: runOf([job]), runtime: new Map(), deps });

    expect(job.status).toBe('error');
    expect(recorder.generateCalls).toHaveLength(0);
  });

  it('sends a closer product framing on the retry when the label could not be verified', async () => {
    const job = product('p1');
    const runtime = runtimeOf([job]);
    runtime.get(job.id)!.labelReference = new File([new Uint8Array([9])], 'label.png', {
      type: 'image/png',
    });
    const { deps, recorder } = depsFor({
      verify: (_job, attempt) => (attempt === 1 ? report('REVIEW') : report('PASS')),
    });

    await runCatalog({ run: runOf([job]), runtime, deps });

    expect(recorder.generateCalls[0].imageName).toBe('p1.png');
    expect(recorder.generateCalls[1].imageName).toBe('label.png');
    expect(job.attempts[1].referenceImage).toBe('product-close-up');
    expect(job.attempts[1].prompt).toContain('framed closer');
    expect(job.attempts[1].prompt).toContain('Keep the entire package in frame');
    expect(job.status).toBe('approved');
  });

  it('keeps the product photo when the label was verified', async () => {
    const job = product('p1');
    const runtime = runtimeOf([job]);
    runtime.get(job.id)!.labelReference = new File([new Uint8Array([9])], 'label.png', {
      type: 'image/png',
    });
    const { deps, recorder } = depsFor({ verify: () => report('PASS') });

    await runCatalog({ run: runOf([job]), runtime, deps });

    expect(recorder.generateCalls).toHaveLength(1);
    expect(recorder.generateCalls[0].imageName).toBe('p1.png');
    expect(job.attempts[0].referenceImage).toBe('product');
  });

  it('reports the strongest attempt when nothing reaches PASS', async () => {
    const job = product('p1');
    const { deps, recorder } = depsFor({
      verify: (_job, attempt) => (attempt === 1 ? report('REVIEW') : report('FAIL')),
    });
    await runCatalog({ run: runOf([job]), runtime: runtimeOf([job]), deps });

    expect(recorder.generateCalls).toHaveLength(3);
    expect(job.status).toBe('needs-review');
    expect(job.approvedAttemptId).toBeNull();
    // Attempt 1 was newest-best: a REVIEW that read the brand beats the later FAILs.
    expect(job.bestAttemptId).toBe(job.attempts[0].id);
    expect(job.evidence).toBe(job.attempts[0].evidence);
    expect(job.message).toContain('Best evidence is attempt 1');
  });

  it('keeps the product message live while a Comfy job runs', async () => {
    const job = product('p1');
    const seen: string[] = [];
    const { deps } = depsFor({
      progressMessage: 'Comfy running · 42% · 1m 02s',
      verify: () => report('PASS'),
    });

    await runCatalog({
      run: runOf([job]),
      runtime: runtimeOf([job]),
      deps,
      onUpdate: (next) => seen.push(next.products[0].message),
    });

    expect(seen.some((message) => message.includes('Comfy running · 42% · 1m 02s'))).toBe(true);
    expect(seen.every((message) => message !== 'Attempt 1 · generating clip')).toBe(true);
  });
});
