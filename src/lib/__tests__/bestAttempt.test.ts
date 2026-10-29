import { describe, expect, it } from 'vitest';
import type { Verdict } from '../../types';
import {
  attemptScore,
  pickBestAttempt,
  type CatalogAttempt,
  type CompactEvidence,
} from '../catalog';

function evidence(verdict: Verdict, brandHits: number, readable = 11, labelHits: number | null = 0): CompactEvidence {
  return {
    verdict,
    headline: `${verdict} headline`,
    summary: 'summary',
    checks: [],
    tokenEvidence: [],
    frames: [],
    metrics: {
      sampledFrames: 12,
      readableFrames: readable,
      brandHits,
      labelHits,
      meanConfidence: 78,
      readableFraction: readable / 12,
    },
    limitations: [],
  };
}

function attempt(index: number, verdict: Verdict | null, data: CompactEvidence | null): CatalogAttempt {
  return {
    id: `att_${index}`,
    index,
    prompt: `prompt ${index}`,
    adjustment: null,
    adjustmentReason: null,
    jobId: `job_${index}`,
    startedAt: '2026-10-29T00:00:00.000Z',
    finishedAt: '2026-10-29T00:01:00.000Z',
    verdict,
    headline: verdict,
    evidence: data,
    estimateCredits: 1,
    error: null,
    videoName: `clip-${index}.mp4`,
    reservationState: 'settled',
  };
}

describe('attempt ranking', () => {
  it('ranks a PASS above REVIEW and REVIEW above FAIL', () => {
    const pass = attemptScore(attempt(1, 'PASS', evidence('PASS', 11)));
    const review = attemptScore(attempt(1, 'REVIEW', evidence('REVIEW', 9)));
    const fail = attemptScore(attempt(1, 'FAIL', evidence('FAIL', 1)));
    expect(pass).toBeGreaterThan(review);
    expect(review).toBeGreaterThan(fail);
  });

  it('prefers the attempt that read the brand in more frames', () => {
    const strong = attemptScore(attempt(1, 'REVIEW', evidence('REVIEW', 9, 11)));
    const weak = attemptScore(attempt(1, 'REVIEW', evidence('REVIEW', 1, 8)));
    expect(strong).toBeGreaterThan(weak);
  });

  it('prefers the attempt with more readable frames at equal brand recall', () => {
    const readable = attemptScore(attempt(1, 'REVIEW', evidence('REVIEW', 5, 10)));
    const sparse = attemptScore(attempt(1, 'REVIEW', evidence('REVIEW', 5, 5)));
    expect(readable).toBeGreaterThan(sparse);
  });

  it('scores an attempt with no evidence at zero', () => {
    expect(attemptScore(attempt(1, null, null))).toBe(0);
  });
});

describe('pickBestAttempt', () => {
  it('picks the first attempt when it is the only one with evidence', () => {
    const first = attempt(1, 'REVIEW', evidence('REVIEW', 9));
    expect(pickBestAttempt([first, attempt(2, null, null)])?.id).toBe(first.id);
  });

  it('does not hand back the last attempt just because it ran last', () => {
    const first = attempt(1, 'REVIEW', evidence('REVIEW', 9, 11));
    const second = attempt(2, 'REVIEW', evidence('REVIEW', 5, 5));
    const third = attempt(3, 'FAIL', evidence('FAIL', 1, 8));
    expect(pickBestAttempt([first, second, third])?.id).toBe(first.id);
  });

  it('picks a genuine PASS wherever it appears', () => {
    const first = attempt(1, 'FAIL', evidence('FAIL', 0));
    const second = attempt(2, 'PASS', evidence('PASS', 11));
    expect(pickBestAttempt([first, second])?.id).toBe(second.id);
  });

  it('prefers the earlier attempt when two are equally strong', () => {
    const first = attempt(1, 'REVIEW', evidence('REVIEW', 9));
    const second = attempt(2, 'REVIEW', evidence('REVIEW', 9));
    expect(pickBestAttempt([first, second])?.id).toBe(first.id);
  });

  it('returns null when no attempt ran', () => {
    expect(pickBestAttempt([])).toBeNull();
  });
});
