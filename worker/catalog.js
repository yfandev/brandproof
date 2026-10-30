/**
 * Catalog Pilot Run server controls for BrandProof.
 *
 * A catalog run generates and verifies several products at once, which means
 * several Comfy Cloud jobs can be in flight together. The browser decides how
 * many products run in parallel; this module is the server-side spend gate:
 * every generation attempt has to reserve budget before the browser is allowed
 * to submit it, and concurrent attempts cannot reserve the same credits twice.
 *
 * Ledger storage:
 *   - D1 (`env.CATALOG_DB`) when bound: durable, shared by every Worker isolate.
 *   - In memory otherwise (local dev / no binding): correct inside one isolate
 *     only, and lost on redeploy or cold start. The status endpoint reports
 *     which mode is active so the UI never presents memory mode as durable.
 *
 * Comfy Cloud API v2 does not report per-job credit usage, so the ledger works
 * in "planning credits": a configurable estimate per attempt
 * (CATALOG_ESTIMATE_CREDITS_PER_ATTEMPT). The UI labels every figure as an
 * estimate, never as provider billing.
 */

export const RETRY_LIMIT = 2;
export const MAX_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_BUDGET_CREDITS = 60;
export const MAX_BUDGET_CREDITS = 400;
export const MAX_PRODUCTS = 8;
export const SAFETY_MARGIN = 0.15;
// Planning credits for a whole day of demo runs: 150 credits is roughly 43
// attempts' worth, enough for repeated judge walkthroughs while still bounded.
const DEFAULT_DAILY_CAP_CREDITS = 150;
const MAX_RUNS_PER_DAY = 60;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CatalogError extends Error {
  constructor(message, { status = 400, code = 'catalog_error' } = {}) {
    super(message);
    this.name = 'CatalogError';
    this.status = status;
    this.code = code;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorResponse(error) {
  const known = error instanceof CatalogError;
  return json(
    {
      error: {
        code: known ? error.code : 'catalog_internal_error',
        message: known
          ? error.message
          : 'BrandProof could not complete the catalog ledger request.',
      },
    },
    known ? error.status : 500,
  );
}

function credit(value) {
  return Math.round(value * 1000) / 1000;
}

function toNumber(value, fallback) {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

export function catalogSettings(env = {}) {
  const estimate = toNumber(env.CATALOG_ESTIMATE_CREDITS_PER_ATTEMPT, 1);
  const dailyCap = toNumber(env.CATALOG_DAILY_CREDIT_CAP, DEFAULT_DAILY_CAP_CREDITS);
  return {
    retryLimit: RETRY_LIMIT,
    maxConcurrency: MAX_CONCURRENCY,
    defaultConcurrency: DEFAULT_CONCURRENCY,
    defaultBudgetCredits: DEFAULT_BUDGET_CREDITS,
    maxBudgetCredits: MAX_BUDGET_CREDITS,
    maxProducts: MAX_PRODUCTS,
    estimateCreditsPerAttempt: estimate > 0 ? estimate : 1,
    safetyMargin: SAFETY_MARGIN,
    dailyCapCredits: dailyCap > 0 ? dailyCap : DEFAULT_DAILY_CAP_CREDITS,
    maxRunsPerDay: MAX_RUNS_PER_DAY,
  };
}

/** Reservation size for one attempt, including the safety margin. */
export function reservationCredits(settings) {
  const base = settings.estimateCreditsPerAttempt;
  return credit(base + Math.ceil(base * settings.safetyMargin * 1000) / 1000);
}

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function runView(row) {
  return {
    id: row.id,
    budgetCredits: credit(row.budget_credits),
    reservedCredits: credit(row.reserved_credits),
    spentCredits: credit(row.spent_credits),
    remainingCredits: credit(
      Math.max(0, row.budget_credits - row.reserved_credits - row.spent_credits),
    ),
    concurrency: row.concurrency,
    productCount: row.product_count,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ memory */

export function createMemoryStore() {
  const runs = new Map();
  const reservations = new Map();
  const daily = new Map();

  const day = (key) => {
    if (!daily.has(key)) daily.set(key, { reserved: 0, spent: 0, runs: 0 });
    return daily.get(key);
  };

  return {
    kind: 'memory',
    async ensure() {},
    async dailyUsage(dayKey) {
      const row = day(dayKey);
      return { reservedCredits: credit(row.reserved), spentCredits: credit(row.spent) };
    },
    async createRun(run, settings, dayKey) {
      const existing = runs.get(run.id);
      if (existing) return { created: false, run: runView(existing) };
      const today = day(dayKey);
      if (today.runs >= settings.maxRunsPerDay) {
        throw new CatalogError(
          `This deployment already created ${settings.maxRunsPerDay} catalog runs today (UTC). Try again tomorrow or raise CATALOG_MAX_RUNS_PER_DAY.`,
          { status: 429, code: 'run_limit' },
        );
      }
      today.runs += 1;
      runs.set(run.id, { ...run, reserved_credits: 0, spent_credits: 0 });
      return { created: true, run: runView(runs.get(run.id)) };
    },
    async getRun(runId) {
      const row = runs.get(runId);
      return row ? runView(row) : null;
    },
    async reserve({ runId, attemptId, productId, credits, dailyCap, dayKey }) {
      const existing = reservations.get(attemptId);
      if (existing) return { state: existing.state, reason: existing.reason ?? null };

      const run = runs.get(runId);
      if (!run) {
        throw new CatalogError('That catalog run does not exist.', {
          status: 404,
          code: 'run_not_found',
        });
      }

      const deny = (reason) => {
        reservations.set(attemptId, { state: 'denied', reason, runId, productId, credits });
        return { state: 'denied', reason };
      };

      if (run.reserved_credits + run.spent_credits + credits > run.budget_credits + 1e-9) {
        return deny('run_budget');
      }
      const today = day(dayKey);
      if (today.reserved + today.spent + credits > dailyCap + 1e-9) {
        return deny('daily_cap');
      }

      run.reserved_credits = credit(run.reserved_credits + credits);
      today.reserved = credit(today.reserved + credits);
      reservations.set(attemptId, { state: 'granted', runId, productId, credits });
      return { state: 'granted', reason: null };
    },
    async settle({ attemptId, outcome, dayKey }) {
      const reservation = reservations.get(attemptId);
      if (!reservation) {
        throw new CatalogError('That attempt has no reservation on this ledger.', {
          status: 404,
          code: 'reservation_not_found',
        });
      }
      if (reservation.state !== 'granted') return { state: reservation.state };

      const run = runs.get(reservation.runId);
      const today = day(dayKey);
      const amount = reservation.credits;

      if (run) run.reserved_credits = credit(Math.max(0, run.reserved_credits - amount));
      today.reserved = credit(Math.max(0, today.reserved - amount));
      if (outcome === 'used') {
        if (run) run.spent_credits = credit(run.spent_credits + amount);
        today.spent = credit(today.spent + amount);
      }
      reservation.state = outcome === 'used' ? 'settled' : 'released';
      return { state: reservation.state };
    },
  };
}

/* ---------------------------------------------------------------------- d1 */

const D1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS catalog_runs (
     id TEXT PRIMARY KEY,
     budget_credits REAL NOT NULL,
     reserved_credits REAL NOT NULL DEFAULT 0,
     spent_credits REAL NOT NULL DEFAULT 0,
     concurrency INTEGER NOT NULL,
     product_count INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS catalog_reservations (
     attempt_id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     product_id TEXT,
     credits REAL NOT NULL,
     state TEXT NOT NULL,
     reason TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS catalog_daily (
     day TEXT PRIMARY KEY,
     reserved_credits REAL NOT NULL DEFAULT 0,
     spent_credits REAL NOT NULL DEFAULT 0,
     runs INTEGER NOT NULL DEFAULT 0
   )`,
];

export function createD1Store(db) {
  let ready = null;
  const ensure = async () => {
    if (!ready) {
      ready = (async () => {
        for (const statement of D1_SCHEMA) {
          await db.prepare(statement).run();
        }
        await db.prepare('INSERT OR IGNORE INTO catalog_daily (day) VALUES (?)').bind(utcDay()).run();
      })().catch((error) => {
        ready = null;
        throw new CatalogError(
          `The catalog ledger database could not be prepared: ${
            error instanceof Error ? error.message : 'D1 error'
          }`,
          { status: 503, code: 'ledger_unavailable' },
        );
      });
    }
    return ready;
  };

  return {
    kind: 'd1',
    ensure,
    async dailyUsage(dayKey) {
      await ensure();
      const row = await db
        .prepare('SELECT reserved_credits, spent_credits FROM catalog_daily WHERE day = ?')
        .bind(dayKey)
        .first();
      return {
        reservedCredits: credit(row?.reserved_credits ?? 0),
        spentCredits: credit(row?.spent_credits ?? 0),
      };
    },
    async createRun(run, settings, dayKey) {
      await ensure();
      const existing = await db
        .prepare('SELECT * FROM catalog_runs WHERE id = ?')
        .bind(run.id)
        .first();
      if (existing) return { created: false, run: runView(existing) };

      await db.prepare('INSERT OR IGNORE INTO catalog_daily (day) VALUES (?)').bind(dayKey).run();
      const gate = await db
        .prepare('UPDATE catalog_daily SET runs = runs + 1 WHERE day = ? AND runs < ?')
        .bind(dayKey, settings.maxRunsPerDay)
        .run();
      if (!gate?.meta?.changes) {
        throw new CatalogError(
          `This deployment already created ${settings.maxRunsPerDay} catalog runs today (UTC). Try again tomorrow.`,
          { status: 429, code: 'run_limit' },
        );
      }

      await db
        .prepare(
          `INSERT INTO catalog_runs
             (id, budget_credits, reserved_credits, spent_credits, concurrency, product_count, created_at)
           VALUES (?, ?, 0, 0, ?, ?, ?)`,
        )
        .bind(run.id, run.budget_credits, run.concurrency, run.product_count, run.created_at)
        .run();

      const row = await db
        .prepare('SELECT * FROM catalog_runs WHERE id = ?')
        .bind(run.id)
        .first();
      return { created: true, run: runView(row) };
    },
    async getRun(runId) {
      await ensure();
      const row = await db
        .prepare('SELECT * FROM catalog_runs WHERE id = ?')
        .bind(runId)
        .first();
      return row ? runView(row) : null;
    },
    async reserve({ runId, attemptId, productId, credits, dailyCap, dayKey }) {
      await ensure();

      const existing = await db
        .prepare('SELECT state, reason FROM catalog_reservations WHERE attempt_id = ?')
        .bind(attemptId)
        .first();
      if (existing) return { state: existing.state, reason: existing.reason ?? null };

      const run = await db
        .prepare('SELECT id FROM catalog_runs WHERE id = ?')
        .bind(runId)
        .first();
      if (!run) {
        throw new CatalogError('That catalog run does not exist.', {
          status: 404,
          code: 'run_not_found',
        });
      }

      const deny = async (reason) => {
        await db
          .prepare(
            `INSERT OR IGNORE INTO catalog_reservations
               (attempt_id, run_id, product_id, credits, state, reason, created_at)
             VALUES (?, ?, ?, ?, 'denied', ?, ?)`,
          )
          .bind(attemptId, runId, productId, credits, reason, new Date().toISOString())
          .run();
        return { state: 'denied', reason };
      };

      const budgetGate = await db
        .prepare(
          `UPDATE catalog_runs SET reserved_credits = reserved_credits + ?
           WHERE id = ? AND spent_credits + reserved_credits + ? <= budget_credits`,
        )
        .bind(credits, runId, credits)
        .run();
      if (!budgetGate?.meta?.changes) return deny('run_budget');

      await db.prepare('INSERT OR IGNORE INTO catalog_daily (day) VALUES (?)').bind(dayKey).run();
      const dailyGate = await db
        .prepare(
          `UPDATE catalog_daily SET reserved_credits = reserved_credits + ?
           WHERE day = ? AND reserved_credits + spent_credits + ? <= ?`,
        )
        .bind(credits, dayKey, credits, dailyCap)
        .run();
      if (!dailyGate?.meta?.changes) {
        await db
          .prepare(
            'UPDATE catalog_runs SET reserved_credits = MAX(0, reserved_credits - ?) WHERE id = ?',
          )
          .bind(credits, runId)
          .run();
        return deny('daily_cap');
      }

      await db
        .prepare(
          `INSERT OR IGNORE INTO catalog_reservations
             (attempt_id, run_id, product_id, credits, state, reason, created_at)
           VALUES (?, ?, ?, ?, 'granted', NULL, ?)`,
        )
        .bind(attemptId, runId, productId, credits, new Date().toISOString())
        .run();
      return { state: 'granted', reason: null };
    },
    async settle({ attemptId, outcome, dayKey }) {
      await ensure();
      const reservation = await db
        .prepare('SELECT * FROM catalog_reservations WHERE attempt_id = ?')
        .bind(attemptId)
        .first();
      if (!reservation) {
        throw new CatalogError('That attempt has no reservation on this ledger.', {
          status: 404,
          code: 'reservation_not_found',
        });
      }
      if (reservation.state !== 'granted') return { state: reservation.state };

      const amount = reservation.credits;
      const nextState = outcome === 'used' ? 'settled' : 'released';
      const statements = [
        db
          .prepare(
            `UPDATE catalog_runs
             SET reserved_credits = MAX(0, reserved_credits - ?),
                 spent_credits = spent_credits + ?
             WHERE id = ?`,
          )
          .bind(amount, outcome === 'used' ? amount : 0, reservation.run_id),
        db
          .prepare(
            `UPDATE catalog_daily
             SET reserved_credits = MAX(0, reserved_credits - ?),
                 spent_credits = spent_credits + ?
             WHERE day = ?`,
          )
          .bind(amount, outcome === 'used' ? amount : 0, dayKey),
        db
          .prepare(
            `UPDATE catalog_reservations SET state = ?
             WHERE attempt_id = ? AND state = 'granted'`,
          )
          .bind(nextState, attemptId),
      ];
      await db.batch(statements);
      return { state: nextState };
    },
  };
}

let memoryStore = createMemoryStore();

export function storeFor(env = {}) {
  if (env.CATALOG_DB && typeof env.CATALOG_DB.prepare === 'function') {
    return createD1Store(env.CATALOG_DB);
  }
  return memoryStore;
}

/** Test hook: clears the process-wide in-memory ledger. */
export function resetMemoryStore() {
  memoryStore = createMemoryStore();
  return memoryStore;
}

/* -------------------------------------------------------------------- routes */

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new CatalogError('The catalog request body was not valid JSON.', {
      status: 400,
      code: 'invalid_body',
    });
  }
}

function requireId(value, label) {
  const text = String(value ?? '').trim();
  if (!ID_PATTERN.test(text)) {
    throw new CatalogError(`${label} is missing or not a valid id.`, {
      status: 400,
      code: 'invalid_id',
    });
  }
  return text;
}

export async function handleCatalogRequest(request, env = {}, options = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  const settings = catalogSettings(env);
  const store = options.store ?? storeFor(env);
  const dayKey = utcDay(options.now ? options.now() : new Date());

  const requireMethod = (expected) => {
    if (method !== expected) {
      throw new CatalogError(`Use ${expected} for this catalog endpoint.`, {
        status: 405,
        code: 'method_not_allowed',
      });
    }
  };

  try {
    if (path === '/api/catalog/config') {
      requireMethod('GET');
      await store.ensure();
      const daily = await store.dailyUsage(dayKey);
      return json({
        ...settings,
        storage: store.kind,
        durable: store.kind === 'd1',
        reservationCredits: reservationCredits(settings),
        costSource: 'estimate',
        day: dayKey,
        dailyReservedCredits: daily.reservedCredits,
        dailySpentCredits: daily.spentCredits,
        dailyRemainingCredits: credit(
          Math.max(0, settings.dailyCapCredits - daily.reservedCredits - daily.spentCredits),
        ),
        notes: [
          'Comfy Cloud API v2 does not report per-job credit usage, so budget figures are planning estimates, not provider billing.',
          store.kind === 'd1'
            ? 'Budget reservations are stored in D1 and shared by every Worker isolate.'
            : 'CATALOG_DB is not bound: the ledger is in Worker memory, per isolate only, and resets on redeploy or cold start.',
        ],
      });
    }

    if (path === '/api/catalog/runs') {
      requireMethod('POST');
      const body = await readJson(request);
      const runId = requireId(body.runId, 'runId');
      const budgetCredits = toNumber(body.budgetCredits, NaN);
      const concurrency = toNumber(body.concurrency, NaN);
      const productCount = toNumber(body.productCount, NaN);

      if (!(budgetCredits > 0) || budgetCredits > settings.maxBudgetCredits) {
        throw new CatalogError(
          `The run budget must be between 0 and ${settings.maxBudgetCredits} credits.`,
          { status: 422, code: 'invalid_budget' },
        );
      }
      if (!(concurrency >= 1) || concurrency > settings.maxConcurrency) {
        throw new CatalogError(
          `Concurrency must be between 1 and ${settings.maxConcurrency}.`,
          { status: 422, code: 'invalid_concurrency' },
        );
      }
      if (!(productCount >= 1) || productCount > settings.maxProducts) {
        throw new CatalogError(`A run accepts 1 to ${settings.maxProducts} products.`, {
          status: 422,
          code: 'invalid_product_count',
        });
      }

      await store.ensure();
      const created = await store.createRun(
        {
          id: runId,
          budget_credits: credit(budgetCredits),
          concurrency,
          product_count: productCount,
          created_at: new Date().toISOString(),
        },
        settings,
        dayKey,
      );
      return json({ run: created.run, created: created.created, settings }, created.created ? 201 : 200);
    }

    const reservationMatch = /^\/api\/catalog\/runs\/([^/]+)\/reservations$/.exec(path);
    if (reservationMatch) {
      requireMethod('POST');
      const runId = requireId(reservationMatch[1], 'runId');
      const body = await readJson(request);
      const attemptId = requireId(body.attemptId, 'attemptId');
      const productId = body.productId == null ? null : String(body.productId).slice(0, 64);
      const credits = reservationCredits(settings);

      await store.ensure();
      const result = await store.reserve({
        runId,
        attemptId,
        productId,
        credits,
        dailyCap: settings.dailyCapCredits,
        dayKey,
      });
      const run = await store.getRun(runId);
      const daily = await store.dailyUsage(dayKey);
      return json({
        granted: result.state === 'granted',
        state: result.state,
        reason: result.reason,
        reservation: { attemptId, credits, estimate: settings.estimateCreditsPerAttempt },
        run,
        daily: {
          day: dayKey,
          reservedCredits: daily.reservedCredits,
          spentCredits: daily.spentCredits,
          capCredits: settings.dailyCapCredits,
        },
      });
    }

    const settleMatch = /^\/api\/catalog\/runs\/([^/]+)\/reservations\/([^/]+)\/settle$/.exec(path);
    if (settleMatch) {
      requireMethod('POST');
      const runId = requireId(settleMatch[1], 'runId');
      const attemptId = requireId(settleMatch[2], 'attemptId');
      const body = await readJson(request);
      const outcome = body.outcome === 'used' ? 'used' : 'released';

      await store.ensure();
      const result = await store.settle({ runId, attemptId, outcome, dayKey });
      const run = await store.getRun(runId);
      return json({ state: result.state, run });
    }

    const runMatch = /^\/api\/catalog\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      requireMethod('GET');
      const runId = requireId(runMatch[1], 'runId');
      await store.ensure();
      const run = await store.getRun(runId);
      if (!run) {
        throw new CatalogError('That catalog run does not exist.', {
          status: 404,
          code: 'run_not_found',
        });
      }
      return json({ run, settings });
    }

    throw new CatalogError('Catalog endpoint not found.', { status: 404, code: 'not_found' });
  } catch (error) {
    return errorResponse(error);
  }
}

export { DAY_PATTERN };
