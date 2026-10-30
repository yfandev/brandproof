import type { VerificationReport } from '../types';
import {
  MAX_ATTEMPTS_PER_PRODUCT,
  adjustmentFromEvidence,
  composeAttemptPrompt,
  isTerminal,
  labelNeedsCloseUp,
  newCatalogId,
  pickBestAttempt,
  summariseReport,
  type CatalogAttempt,
  type CatalogProductJob,
  type CatalogRun,
} from './catalog';

/** The browser-only half of a product: its photo, reference canvas and prompt. */
export interface CatalogRuntimeProduct {
  image: File;
  reference: { canvas: HTMLCanvasElement } | null;
  basePrompt: string;
  /** Cropped, upscaled label used after an attempt could not verify the text. */
  labelReference?: File | null;
}

const CLOSE_UP_NOTE =
  'The reference image is a close-up of the printed label. Keep that label filling the frame and reproduce every letter exactly as printed, with no added, duplicated or restyled lettering.';

export interface CatalogRunnerDeps {
  /** Server-side budget gate. Must be called before one generation attempt. */
  reserve(input: { runId: string; attemptId: string; productId: string }): Promise<{
    granted: boolean;
    reason: string | null;
    credits: number;
  }>;
  settle(input: { runId: string; attemptId: string; outcome: 'used' | 'released' }): Promise<void>;
  generate(input: {
    image: File;
    prompt: string;
    attemptId: string;
    onJobId: (jobId: string) => void;
  }): Promise<{ blob: Blob; filename: string; jobId: string | null }>;
  verify(input: {
    blob: Blob;
    filename: string;
    product: CatalogRuntimeProduct;
    job: CatalogProductJob;
    /** Comfy job id, so verification can fall back to the Worker stream. */
    jobId: string | null;
  }): Promise<VerificationReport>;
  onClip?: (input: {
    productId: string;
    attemptId: string;
    attemptIndex: number;
    blob: Blob;
    filename: string;
  }) => void;
}

export interface RunCatalogOptions {
  run: CatalogRun;
  runtime: Map<string, CatalogRuntimeProduct>;
  deps: CatalogRunnerDeps;
  onUpdate?: (run: CatalogRun) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** OCR runs through one Tesseract worker, so verification is serialised. */
  verifyQueue?: <T>(task: () => Promise<T>) => Promise<T>;
}

function cloneRun(run: CatalogRun): CatalogRun {
  return {
    ...run,
    products: run.products.map((product) => ({
      ...product,
      attempts: product.attempts.map((attempt) => ({ ...attempt })),
    })),
  };
}

/** A concurrency-limited pool: each lane pulls the next product as it frees up. */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, queue.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await worker(next);
      }
    }),
  );
}

/** FIFO queue so concurrent products never drive the shared OCR worker at once. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = tail.then(task, task);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

function retryable(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status ?? 0;
  return status === 0 || status === 429 || status >= 500;
}

/** Bounded backoff for ledger calls; only retries transient failures. */
export async function withLedgerRetry<T>(
  task: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!retryable(error) || index === attempts - 1) throw error;
      await sleep(250 * 2 ** index);
    }
  }
  throw lastError ?? new Error('The ledger request failed.');
}

function budgetMessage(reason: string | null): string {
  if (reason === 'daily_cap') {
    return 'The deployment daily credit cap is reached, so no new generation was started for this product.';
  }
  return 'The run budget cannot cover another attempt, so this product stopped without a new generation.';
}

/**
 * Runs every product through the real generate → verify loop, concurrently up
 * to `config.concurrency`. One product never blocks another: a slow or failing
 * product only occupies its own lane, and exhausting its attempts marks it for
 * human review while the rest of the catalog continues.
 */
export async function runCatalog(options: RunCatalogOptions): Promise<CatalogRun> {
  const { run, runtime, deps } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const enqueueVerify = options.verifyQueue ?? createSerialQueue();
  const maxAttempts = Math.max(1, Math.min(run.config.maxAttempts, MAX_ATTEMPTS_PER_PRODUCT));
  const emit = () => options.onUpdate?.(cloneRun(run));

  const finishProduct = (job: CatalogProductJob) => {
    job.finishedAt = now().toISOString();
  };

  /** Point the product at its strongest attempt once the loop is over. */
  const syncBest = (job: CatalogProductJob): CatalogAttempt | null => {
    const best = pickBestAttempt(job.attempts);
    job.bestAttemptId = best?.id ?? null;
    if (best?.evidence) {
      job.evidence = best.evidence;
      job.videoName = best.videoName ?? job.videoName;
    }
    return best;
  };

  const settle = async (attempt: CatalogAttempt, outcome: 'used' | 'released') => {
    try {
      await withLedgerRetry(
        () => deps.settle({ runId: run.id, attemptId: attempt.id, outcome }),
        sleep,
      );
      attempt.reservationState = outcome === 'used' ? 'settled' : 'released';
    } catch (error) {
      attempt.reservationState = outcome === 'used' ? 'settled' : 'granted';
      attempt.error = attempt.error ?? `Ledger settlement failed: ${errorMessage(error)}`;
    }
  };

  const processProduct = async (job: CatalogProductJob): Promise<void> => {
    const product = runtime.get(job.id);
    if (!product) {
      job.status = 'error';
      job.message = 'This product has no photo loaded in this browser, so no generation was started.';
      finishProduct(job);
      emit();
      return;
    }

    job.startedAt = job.startedAt ?? now().toISOString();
    let pendingAdjustment: string | null = null;
    let pendingReason: string | null = null;

    while (job.attempts.length < maxAttempts) {
      const attemptIndex = job.attempts.length + 1;
      const previous = job.attempts[job.attempts.length - 1] ?? null;
      // Once the label could not be verified, send a close-up of the label so the
      // model has enough pixels to render the printed line.
      const useCloseUp = Boolean(product.labelReference) && labelNeedsCloseUp(previous?.evidence ?? null);
      const image = useCloseUp ? (product.labelReference as File) : product.image;
      const prompt = composeAttemptPrompt(product.basePrompt, pendingAdjustment) +
        (useCloseUp ? `\n\n${CLOSE_UP_NOTE}` : '');
      const attempt: CatalogAttempt = {
        id: newCatalogId('att'),
        index: attemptIndex,
        prompt,
        adjustment: pendingAdjustment,
        adjustmentReason: pendingReason,
        jobId: null,
        startedAt: now().toISOString(),
        finishedAt: null,
        verdict: null,
        headline: null,
        evidence: null,
        estimateCredits: 0,
        error: null,
        videoName: null,
        reservationState: null,
        referenceImage: useCloseUp ? 'label-close-up' : 'product',
      };
      job.attempts.push(attempt);
      job.status = 'generating';
      job.message = `Attempt ${attemptIndex} of ${maxAttempts} · generating clip${
        useCloseUp ? ' from a label close-up' : ''
      }`;
      emit();

      let granted: { granted: boolean; reason: string | null; credits: number };
      try {
        granted = await withLedgerRetry(
          () => deps.reserve({ runId: run.id, attemptId: attempt.id, productId: job.id }),
          sleep,
        );
      } catch (error) {
        attempt.error = `Budget reservation failed: ${errorMessage(error)}`;
        attempt.finishedAt = now().toISOString();
        attempt.reservationState = 'denied';
        job.status = 'error';
        job.message = attempt.error;
        finishProduct(job);
        emit();
        return;
      }

      if (!granted.granted) {
        attempt.reservationState = 'denied';
        attempt.error = budgetMessage(granted.reason);
        attempt.finishedAt = now().toISOString();
        job.status = 'budget-limited';
        job.message = attempt.error;
        finishProduct(job);
        emit();
        return;
      }

      attempt.reservationState = 'granted';
      attempt.estimateCredits = granted.credits;
      emit();

      let clip: { blob: Blob; filename: string; jobId: string | null };
      try {
        clip = await deps.generate({
          image,
          prompt,
          attemptId: attempt.id,
          onJobId: (jobId) => {
            attempt.jobId = jobId;
            emit();
          },
        });
      } catch (error) {
        attempt.error = errorMessage(error);
        attempt.finishedAt = now().toISOString();
        await settle(attempt, 'released');
        if (job.attempts.length >= maxAttempts) {
          job.status = 'error';
          job.message = `Generation failed on all ${maxAttempts} attempts: ${attempt.error}`;
          finishProduct(job);
        } else {
          job.status = 'retrying';
          job.message = `Attempt ${attemptIndex} failed to generate: ${attempt.error}`;
          pendingAdjustment = null;
          pendingReason = null;
        }
        emit();
        continue;
      }

      attempt.videoName = clip.filename;
      attempt.jobId = attempt.jobId ?? clip.jobId;
      await settle(attempt, 'used');
      // Every attempt keeps its own clip: a later retry must not replace the
      // evidence of what the previous attempt actually generated.
      deps.onClip?.({
        productId: job.id,
        attemptId: attempt.id,
        attemptIndex,
        blob: clip.blob,
        filename: clip.filename,
      });
      job.videoName = clip.filename;

      job.status = 'verifying';
      job.message = `Attempt ${attemptIndex} · running OCR on the returned MP4`;
      emit();

      let report: VerificationReport;
      try {
        report = await enqueueVerify(() =>
          deps.verify({
            blob: clip.blob,
            filename: clip.filename,
            product,
            job,
            jobId: attempt.jobId ?? clip.jobId ?? null,
          }),
        );
      } catch (error) {
        attempt.error = `Verification failed: ${errorMessage(error)}`;
        attempt.finishedAt = now().toISOString();
        if (job.attempts.length >= maxAttempts) {
          job.status = 'error';
          job.message = attempt.error;
          finishProduct(job);
        } else {
          job.status = 'retrying';
          job.message = `${attempt.error} Trying another attempt.`;
          const next = adjustmentFromEvidence(attempt.evidence, attemptIndex + 1);
          pendingAdjustment = next.adjustment;
          pendingReason = next.reason;
        }
        emit();
        continue;
      }

      attempt.verdict = report.verdict;
      attempt.headline = report.headline;
      attempt.evidence = summariseReport(report);
      attempt.finishedAt = now().toISOString();
      job.evidence = attempt.evidence;

      if (report.verdict === 'PASS') {
        job.status = 'approved';
        job.approvedAttemptId = attempt.id;
        job.bestAttemptId = attempt.id;
        job.message = `Approved on attempt ${attemptIndex}: ${report.headline}`;
        finishProduct(job);
        emit();
        return;
      }

      if (job.attempts.length >= maxAttempts) {
        const best = syncBest(job);
        job.status = 'needs-review';
        job.message = `No attempt reached PASS in ${maxAttempts}. Best evidence is attempt ${
          best?.index ?? '—'
        } (${best?.verdict ?? 'no verdict'}), not the last attempt — open its clip and evidence below. ${report.headline}`;
        finishProduct(job);
        emit();
        return;
      }

      const next = adjustmentFromEvidence(attempt.evidence, attemptIndex + 1);
      pendingAdjustment = next.adjustment;
      pendingReason = next.reason;
      job.status = 'retrying';
      job.message = `Attempt ${attemptIndex} came back ${report.verdict}. Next attempt uses an evidence-based revision.`;
      emit();
    }
  };

  await runPool(run.products, run.config.concurrency, processProduct);

  if (run.products.every((product) => isTerminal(product.status))) {
    run.status = 'complete';
    run.finishedAt = now().toISOString();
  }
  emit();
  return run;
}
