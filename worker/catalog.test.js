import { beforeEach, describe, expect, it } from 'vitest';
import { handleCatalogRequest, resetMemoryStore } from './catalog.js';

const ENV = {
  CATALOG_ESTIMATE_CREDITS_PER_ATTEMPT: '1',
  CATALOG_DAILY_CREDIT_CAP: '100',
};

function call(path, { method = 'GET', body, env = ENV } = {}) {
  const request = new Request(`https://brandproof.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleCatalogRequest(request, env).then(async (response) => ({
    status: response.status,
    body: await response.json(),
  }));
}

async function createRun(overrides = {}, env = ENV) {
  return call('/api/catalog/runs', {
    method: 'POST',
    env,
    body: {
      runId: 'run_00000001',
      budgetCredits: 10,
      concurrency: 3,
      productCount: 2,
      ...overrides,
    },
  });
}

function reserve(runId, attemptId, env = ENV) {
  return call(`/api/catalog/runs/${runId}/reservations`, {
    method: 'POST',
    env,
    body: { attemptId, productId: 'p1' },
  });
}

beforeEach(() => {
  resetMemoryStore();
});

describe('catalog config endpoint', () => {
  it('reports limits and that the in-memory ledger is not durable', async () => {
    const { status, body } = await call('/api/catalog/config');
    expect(status).toBe(200);
    expect(body.durable).toBe(false);
    expect(body.storage).toBe('memory');
    expect(body.retryLimit).toBe(2);
    expect(body.maxConcurrency).toBe(4);
    expect(body.estimateCreditsPerAttempt).toBe(1);
    expect(body.reservationCredits).toBeCloseTo(1.15);
    expect(body.costSource).toBe('estimate');
  });
});

describe('catalog run creation', () => {
  it('creates a run once and treats a repeat as idempotent', async () => {
    const first = await createRun();
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.run.budgetCredits).toBe(10);

    const second = await createRun();
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.run.id).toBe(first.body.run.id);
  });

  it('rejects budgets and concurrency outside the configured limits', async () => {
    const budget = await createRun({ budgetCredits: 0 });
    expect(budget.status).toBe(422);
    expect(budget.body.error.code).toBe('invalid_budget');

    const concurrency = await createRun({ concurrency: 9 });
    expect(concurrency.status).toBe(422);
    expect(concurrency.body.error.code).toBe('invalid_concurrency');
  });
});

describe('catalog budget reservations', () => {
  it('grants only what the run budget covers', async () => {
    await createRun({ budgetCredits: 2.3 });
    const first = await reserve('run_00000001', 'attempt_0001');
    const second = await reserve('run_00000001', 'attempt_0002');
    const third = await reserve('run_00000001', 'attempt_0003');

    expect(first.body.granted).toBe(true);
    expect(second.body.granted).toBe(true);
    expect(third.body.granted).toBe(false);
    expect(third.body.reason).toBe('run_budget');
    expect(third.body.run.reservedCredits).toBeCloseTo(2.3);
    expect(third.body.run.remainingCredits).toBe(0);
  });

  it('cannot let concurrent reservations spend the same credits', async () => {
    await createRun({ budgetCredits: 1.15 });
    const responses = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((suffix) => reserve('run_00000001', `attempt_00${suffix}`)),
    );
    const granted = responses.filter((response) => response.body.granted);
    expect(granted).toHaveLength(1);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it('is idempotent for a repeated attempt id', async () => {
    await createRun();
    const first = await reserve('run_00000001', 'attempt_0001');
    const second = await reserve('run_00000001', 'attempt_0001');
    expect(first.body.granted).toBe(true);
    expect(second.body.granted).toBe(true);
    expect(second.body.run.reservedCredits).toBeCloseTo(1.15);
  });

  it('denies when the deployment daily cap would be exceeded', async () => {
    const env = { ...ENV, CATALOG_DAILY_CREDIT_CAP: '1' };
    await createRun({}, env);
    const { body } = await reserve('run_00000001', 'attempt_0001', env);
    expect(body.granted).toBe(false);
    expect(body.reason).toBe('daily_cap');
  });
});

describe('catalog settlement', () => {
  it('moves a used reservation into spent and frees the hold', async () => {
    await createRun({ budgetCredits: 2.3 });
    await reserve('run_00000001', 'attempt_0001');
    const settled = await call('/api/catalog/runs/run_00000001/reservations/attempt_0001/settle', {
      method: 'POST',
      body: { outcome: 'used' },
    });

    expect(settled.body.state).toBe('settled');
    expect(settled.body.run.reservedCredits).toBe(0);
    expect(settled.body.run.spentCredits).toBeCloseTo(1.15);
    expect(settled.body.run.remainingCredits).toBeCloseTo(1.15);
  });

  it('refunds a released reservation without counting it as a clip', async () => {
    await createRun({ budgetCredits: 2.3 });
    await reserve('run_00000001', 'attempt_0001');
    await call('/api/catalog/runs/run_00000001/reservations/attempt_0001/settle', {
      method: 'POST',
      body: { outcome: 'released' },
    });
    const run = await call('/api/catalog/runs/run_00000001');
    expect(run.body.run.spentCredits).toBe(0);
    expect(run.body.run.reservedCredits).toBe(0);
    expect(run.body.run.remainingCredits).toBeCloseTo(2.3);
  });

  it('is idempotent when a settle is replayed', async () => {
    await createRun();
    await reserve('run_00000001', 'attempt_0001');
    await call('/api/catalog/runs/run_00000001/reservations/attempt_0001/settle', {
      method: 'POST',
      body: { outcome: 'used' },
    });
    const replay = await call('/api/catalog/runs/run_00000001/reservations/attempt_0001/settle', {
      method: 'POST',
      body: { outcome: 'used' },
    });
    expect(replay.body.state).toBe('settled');
    expect(replay.body.run.spentCredits).toBeCloseTo(1.15);
  });
});

describe('catalog errors', () => {
  it('returns 404 for an unknown run', async () => {
    const { status, body } = await reserve('run_missing1', 'attempt_0001');
    expect(status).toBe(404);
    expect(body.error.code).toBe('run_not_found');
  });

  it('rejects a malformed id', async () => {
    const { status, body } = await reserve('run_00000001', 'x');
    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_id');
  });

  it('rejects the wrong method', async () => {
    const { status } = await call('/api/catalog/runs', { method: 'GET' });
    expect(status).toBe(405);
  });
});
