import { describe, expect, it } from 'vitest';
import type { CloudJob } from '../cloud';
import { describeCloudJob } from '../catalogRunner';

function job(patch: Partial<CloudJob> = {}): CloudJob {
  return {
    id: 'job-1',
    status: 'running',
    queuePosition: null,
    progress: null,
    outputs: [],
    error: null,
    ...patch,
  };
}

describe('describeCloudJob', () => {
  it('names the queue position while a job waits', () => {
    expect(describeCloudJob(job({ status: 'queued', queuePosition: 2 }), 5000)).toBe(
      'Comfy queued · queue 2 · 0m 05s',
    );
  });

  it('reports fractional progress as a percentage', () => {
    expect(
      describeCloudJob(job({ progress: { value: 0.42, nodesDone: 3, nodesTotal: 9, step: null, steps: null, message: null } }), 90000),
    ).toBe('Comfy running · 42% · 1m 30s');
  });

  it('accepts a whole-number percentage and clamps it', () => {
    expect(
      describeCloudJob(job({ progress: { value: 140, nodesDone: null, nodesTotal: null, step: null, steps: null, message: null } }), 0),
    ).toBe('Comfy running · 100% · 0m 00s');
  });

  it('falls back to node counters when no percentage is published', () => {
    expect(
      describeCloudJob(job({ progress: { value: null, nodesDone: 4, nodesTotal: 12, step: null, steps: null, message: null } }), 61000),
    ).toBe('Comfy running · 4/12 nodes · 1m 01s');
  });
});
