/** Browser client for the catalog ledger endpoints served by the Worker. */

export interface CatalogSettings {
  storage: 'd1' | 'memory';
  durable: boolean;
  retryLimit: number;
  maxConcurrency: number;
  defaultConcurrency: number;
  defaultBudgetCredits: number;
  maxBudgetCredits: number;
  maxProducts: number;
  estimateCreditsPerAttempt: number;
  safetyMargin: number;
  dailyCapCredits: number;
  reservationCredits: number;
  costSource: 'estimate';
  day: string;
  dailyReservedCredits: number;
  dailySpentCredits: number;
  dailyRemainingCredits: number;
  notes: string[];
}

export interface LedgerRun {
  id: string;
  budgetCredits: number;
  reservedCredits: number;
  spentCredits: number;
  remainingCredits: number;
  concurrency: number;
  productCount: number;
  createdAt: string;
}

export class CatalogApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, { code = 'catalog_error', status = 0 } = {}) {
    super(message);
    this.name = 'CatalogApiError';
    this.code = code;
    this.status = status;
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  } catch (error) {
    if (init.signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
    throw new CatalogApiError(
      `Could not reach the catalog ledger: ${error instanceof Error ? error.message : 'network error'}.`,
      { code: 'ledger_unreachable' },
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = (payload as { error?: { message?: string; code?: string } } | null)?.error;
    throw new CatalogApiError(
      detail?.message || `The catalog ledger request failed (HTTP ${response.status}).`,
      { code: detail?.code || `http_${response.status}`, status: response.status },
    );
  }
  return payload as T;
}

export function fetchCatalogSettings(signal?: AbortSignal): Promise<CatalogSettings> {
  return requestJson<CatalogSettings>('/api/catalog/config', { signal });
}

export interface CreateRunInput {
  runId: string;
  budgetCredits: number;
  concurrency: number;
  productCount: number;
}

export interface CreateRunResult {
  run: LedgerRun;
  created: boolean;
}

export function createCatalogRun(input: CreateRunInput): Promise<CreateRunResult> {
  return requestJson<CreateRunResult>('/api/catalog/runs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface ReserveResult {
  granted: boolean;
  state: 'granted' | 'denied';
  reason: string | null;
  reservation: { attemptId: string; credits: number; estimate: number };
  run: LedgerRun | null;
  daily: {
    day: string;
    reservedCredits: number;
    spentCredits: number;
    capCredits: number;
  };
}

export function reserveCatalogAttempt(input: {
  runId: string;
  attemptId: string;
  productId: string;
}): Promise<ReserveResult> {
  return requestJson<ReserveResult>(
    `/api/catalog/runs/${encodeURIComponent(input.runId)}/reservations`,
    {
      method: 'POST',
      body: JSON.stringify({ attemptId: input.attemptId, productId: input.productId }),
    },
  );
}

export function settleCatalogAttempt(input: {
  runId: string;
  attemptId: string;
  outcome: 'used' | 'released';
}): Promise<{ state: string; run: LedgerRun | null }> {
  return requestJson(
    `/api/catalog/runs/${encodeURIComponent(input.runId)}/reservations/${encodeURIComponent(
      input.attemptId,
    )}/settle`,
    { method: 'POST', body: JSON.stringify({ outcome: input.outcome }) },
  );
}
