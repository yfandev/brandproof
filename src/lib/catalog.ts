import type {
  CheckResult,
  SceneId,
  Strictness,
  TokenEvidence,
  TokenFinding,
  VerificationReport,
  Verdict,
  VerifyConfig,
} from '../types';
import { buildPrompt } from './scenes';

/** Total generation attempts allowed per product, including the first one. */
export const MAX_ATTEMPTS_PER_PRODUCT = 3;
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 4;
export const DEFAULT_BUDGET_CREDITS = 12;
export const DEFAULT_ESTIMATE_CREDITS = 1;
export const MAX_PRODUCTS = 8;

export type CatalogProductStatus =
  | 'queued'
  | 'generating'
  | 'verifying'
  | 'retrying'
  | 'approved'
  | 'needs-review'
  | 'budget-limited'
  | 'error'
  | 'interrupted';

export const TERMINAL_STATUSES: CatalogProductStatus[] = [
  'approved',
  'needs-review',
  'budget-limited',
  'error',
  'interrupted',
];

export function isTerminal(status: CatalogProductStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const STATUS_LABEL: Record<CatalogProductStatus, string> = {
  queued: 'Queued',
  generating: 'Generating',
  verifying: 'Verifying',
  retrying: 'Retrying',
  approved: 'Approved',
  'needs-review': 'Needs human review',
  'budget-limited': 'Budget limited',
  error: 'Error',
  interrupted: 'Interrupted',
};

export interface CatalogRunConfig {
  concurrency: number;
  budgetCredits: number;
  maxAttempts: number;
  scene: SceneId;
  strictness: Strictness;
  sampleCount: number;
  coverage: number;
  labelCritical: boolean;
}

export const DEFAULT_RUN_CONFIG: CatalogRunConfig = {
  concurrency: DEFAULT_CONCURRENCY,
  budgetCredits: DEFAULT_BUDGET_CREDITS,
  maxAttempts: MAX_ATTEMPTS_PER_PRODUCT,
  scene: 'luxury-studio',
  strictness: 'balanced',
  sampleCount: 12,
  coverage: 0.6,
  labelCritical: true,
};

export interface CatalogProductDraft {
  id: string;
  name: string;
  brand: string;
  labelText: string;
  instructions: string;
}

export interface TokenFindingRecord {
  token: string;
  kind: 'brand' | 'label';
  finding: TokenFinding;
  bestReading: string | null;
  bestSimilarity: number;
  hits: number;
  missing: number;
  unreadable: number;
}

export interface CompactFrameEvidence {
  index: number;
  time: number;
  status: string;
  text: string;
  meanConfidence: number;
}

/** A small, serialisable slice of a real verification report. */
export interface CompactEvidence {
  verdict: Verdict;
  headline: string;
  summary: string;
  checks: CheckResult[];
  tokenEvidence: TokenFindingRecord[];
  frames: CompactFrameEvidence[];
  metrics: {
    sampledFrames: number;
    readableFrames: number;
    brandHits: number;
    labelHits: number | null;
    meanConfidence: number;
    readableFraction: number;
  };
  limitations: string[];
}

export interface CatalogAttempt {
  id: string;
  index: number;
  prompt: string;
  adjustment: string | null;
  adjustmentReason: string | null;
  jobId: string | null;
  startedAt: string;
  finishedAt: string | null;
  verdict: Verdict | null;
  headline: string | null;
  evidence: CompactEvidence | null;
  /** Planning credits reserved for this attempt. Not provider billing. */
  estimateCredits: number;
  error: string | null;
  videoName: string | null;
  reservationState: 'granted' | 'denied' | 'released' | 'settled' | null;
}

export interface CatalogProductJob {
  id: string;
  name: string;
  brand: string;
  labelText: string;
  instructions: string;
  status: CatalogProductStatus;
  message: string;
  attempts: CatalogAttempt[];
  evidence: CompactEvidence | null;
  approvedAttemptId: string | null;
  videoName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CatalogRun {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  status: 'running' | 'complete';
  config: CatalogRunConfig;
  /** Persisted server-side ceiling, once the ledger accepted the run. */
  serverBudgetCredits: number | null;
  products: CatalogProductJob[];
}

export class CatalogValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems[0] ?? 'The catalog is not ready to run.');
    this.name = 'CatalogValidationError';
    this.problems = problems;
  }
}

export function newCatalogId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
}

export function splitChecks(labelText: string): string[] {
  return labelText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function emptyDraft(id = newCatalogId('p')): CatalogProductDraft {
  return { id, name: '', brand: '', labelText: '', instructions: '' };
}

/** Validates the editable rows before a run can be started. */
export function validateDrafts(drafts: CatalogProductDraft[], hasImage: (id: string) => boolean): string[] {
  const problems: string[] = [];
  if (drafts.length === 0) problems.push('Add at least one product.');
  if (drafts.length > MAX_PRODUCTS) problems.push(`A run accepts at most ${MAX_PRODUCTS} products.`);

  const seen = new Set<string>();
  drafts.forEach((draft, index) => {
    const label = draft.name.trim() || `Product ${index + 1}`;
    if (!draft.name.trim()) problems.push(`${label}: add a product name.`);
    if (!draft.brand.trim()) problems.push(`${label}: add the exact brand name to preserve.`);
    // Label lines are optional: with none, only the brand name is checked.
    if (!hasImage(draft.id)) problems.push(`${label}: add a product photo.`);
    if (seen.has(draft.id)) problems.push(`${label}: duplicate product row.`);
    seen.add(draft.id);
  });
  return problems;
}

export function validateRunConfig(config: CatalogRunConfig): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > MAX_CONCURRENCY) {
    problems.push(`Concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}.`);
  }
  if (!Number.isFinite(config.budgetCredits) || config.budgetCredits <= 0) {
    problems.push('Set a run budget above zero credits.');
  }
  if (config.sampleCount < 4 || config.sampleCount > 24) {
    problems.push('Sample 4 to 24 frames per clip.');
  }
  return problems;
}

/** Base prompt for one catalog product, before any evidence-based revision. */
export function buildCatalogPrompt(draft: CatalogProductDraft, config: CatalogRunConfig): string {
  const base = buildPrompt(config.scene, draft.brand, draft.labelText);
  const extra = draft.instructions.trim();
  if (!extra) return base;
  return `${base}\nProduct-specific direction: ${extra}`;
}

export interface PromptAdjustment {
  adjustment: string;
  reason: string;
}

function listTokens(records: TokenFindingRecord[]): string {
  return records
    .map((record) => record.token)
    .filter(Boolean)
    .slice(0, 4)
    .join(', ');
}

/**
 * Builds the next attempt's revision strictly from recorded OC evidence.
 * It never asserts what the label looked like: it names the observed finding
 * and asks the generator for conditions that make text easier to read.
 */
export function adjustmentFromEvidence(
  evidence: CompactEvidence | null,
  attemptNumber: number,
): PromptAdjustment {
  const findings = evidence?.tokenEvidence ?? [];
  const notDetected = findings.filter((entry) => entry.finding === 'not-detected');
  const distorted = findings.filter((entry) => entry.finding === 'visibly-distorted');
  const unreadable = findings.filter(
    (entry) => entry.finding === 'unreadable' || entry.finding === 'insufficient-evidence',
  );

  const parts: string[] = [];
  const reasons: string[] = [];

  if (notDetected.length > 0) {
    parts.push(
      `Keep the label fully visible in every frame: hold the required lines "${listTokens(notDetected)}" facing the camera, centred and large in frame, with one slow push-in and no cuts, flips or rotation.`,
    );
    reasons.push(`OCR did not detect: ${listTokens(notDetected)}`);
  }
  if (distorted.length > 0) {
    parts.push(
      'Keep the packaging rigid and the printed lettering untouched: minimal product motion, a locked-off or very slow camera, no warping, stretching or re-lettering of the label.',
    );
    reasons.push(`OCR read altered lettering for: ${listTokens(distorted)}`);
  }
  if (unreadable.length > 0) {
    parts.push(
      'Make the label easier to read: closer framing so the label fills more of the frame, unobstructed, evenly lit, with no glare, reflections or motion blur across the text.',
    );
    reasons.push(`OCR could not read: ${listTokens(unreadable)}`);
  }
  if (parts.length === 0) {
    parts.push(
      'Increase label legibility: closer framing, slower camera movement, even lighting and minimal product motion so the printed text stays sharp throughout the clip.',
    );
    reasons.push(
      evidence
        ? `Verdict ${evidence.verdict} with no single dominant token failure`
        : 'No token-level evidence was captured for this attempt',
    );
  }

  return {
    adjustment: `Revision for attempt ${attemptNumber}: ${parts.join(' ')}`,
    reason: reasons.join('; '),
  };
}

export function composeAttemptPrompt(basePrompt: string, adjustment: string | null): string {
  return adjustment ? `${basePrompt}\n\n${adjustment}` : basePrompt;
}

export function summariseReport(report: VerificationReport): CompactEvidence {
  return {
    verdict: report.verdict,
    headline: report.headline,
    summary: report.summary,
    checks: report.checks,
    tokenEvidence: report.tokenEvidence.map((entry: TokenEvidence) => ({
      token: entry.token,
      kind: entry.kind,
      finding: entry.finding,
      bestReading: entry.bestReading,
      bestSimilarity: entry.bestSimilarity,
      hits: entry.hits,
      missing: entry.missing,
      unreadable: entry.unreadable,
    })),
    frames: report.frames.map((frame) => ({
      index: frame.index,
      time: frame.time,
      status: frame.status,
      text: frame.text,
      meanConfidence: frame.meanConfidence,
    })),
    metrics: {
      sampledFrames: report.metrics.sampledFrames,
      readableFrames: report.metrics.readableFrames,
      brandHits: report.metrics.brandHits,
      labelHits: report.metrics.labelHits,
      meanConfidence: report.metrics.meanConfidence,
      readableFraction: report.metrics.readableFraction,
    },
    limitations: report.limitations,
  };
}

export function verificationConfigFor(
  job: Pick<CatalogProductJob, 'brand' | 'labelText'>,
  config: CatalogRunConfig,
): VerifyConfig {
  return {
    brand: job.brand,
    labelText: job.labelText,
    scene: config.scene,
    strictness: config.strictness,
    coverage: config.coverage,
    sampleCount: config.sampleCount,
    labelCritical: config.labelCritical,
    region: null,
  };
}

export function createProductJob(draft: CatalogProductDraft): CatalogProductJob {
  return {
    id: draft.id,
    name: draft.name.trim(),
    brand: draft.brand.trim(),
    labelText: draft.labelText.trim(),
    instructions: draft.instructions.trim(),
    status: 'queued',
    message: 'Waiting for a generation slot.',
    attempts: [],
    evidence: null,
    approvedAttemptId: null,
    videoName: null,
    startedAt: null,
    finishedAt: null,
  };
}

export interface CatalogMetrics {
  submitted: number;
  approved: number;
  needsReview: number;
  budgetLimited: number;
  errors: number;
  interrupted: number;
  running: number;
  attempts: number;
  generatedClips: number;
  /** Planning credits from the server ledger. Never provider billing. */
  estimatedCredits: number;
  actualCredits: number | null;
  approvalRate: number | null;
  costPerApprovedClip: number | null;
  completedProducts: number;
  complete: boolean;
}

export function computeMetrics(run: CatalogRun): CatalogMetrics {
  const products = run.products;
  const attempts = products.flatMap((product) => product.attempts);
  const approved = products.filter((product) => product.status === 'approved').length;
  const estimatedCredits = attempts
    .filter((attempt) => attempt.reservationState === 'settled')
    .reduce((total, attempt) => total + attempt.estimateCredits, 0);

  return {
    submitted: products.length,
    approved,
    needsReview: products.filter((product) => product.status === 'needs-review').length,
    budgetLimited: products.filter((product) => product.status === 'budget-limited').length,
    errors: products.filter((product) => product.status === 'error').length,
    interrupted: products.filter((product) => product.status === 'interrupted').length,
    running: products.filter((product) => !isTerminal(product.status)).length,
    attempts: attempts.length,
    generatedClips: attempts.filter((attempt) => attempt.reservationState === 'settled').length,
    estimatedCredits: Math.round(estimatedCredits * 1000) / 1000,
    actualCredits: null,
    approvalRate: products.length > 0 ? approved / products.length : null,
    costPerApprovedClip:
      approved > 0 ? Math.round((estimatedCredits / approved) * 1000) / 1000 : null,
    completedProducts: products.filter((product) => isTerminal(product.status)).length,
    complete: products.every((product) => isTerminal(product.status)),
  };
}

export function describeAdjustment(attempt: CatalogAttempt): string {
  return attempt.adjustment ?? 'Initial attempt — no revision applied.';
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER = [
  'product',
  'brand',
  'status',
  'attempts',
  'approved',
  'final_verdict',
  'failed_checks',
  'sampled_frames',
  'readable_frames',
  'estimated_credits',
  'actual_credits',
  'video',
  'job_ids',
  'last_message',
  'finished_at',
];

export function runToCsv(run: CatalogRun): string {
  const rows = run.products.map((product) => {
    const finalAttempt = product.attempts[product.attempts.length - 1] ?? null;
    const failed = (product.evidence?.checks ?? [])
      .filter((check) => check.status === 'fail' || check.status === 'review')
      .map((check) => `${check.title}: ${check.status}`)
      .join(' | ');
    return [
      product.name,
      product.brand,
      product.status,
      product.attempts.length,
      product.status === 'approved' ? 'yes' : 'no',
      finalAttempt?.verdict ?? '',
      failed,
      product.evidence?.metrics.sampledFrames ?? '',
      product.evidence?.metrics.readableFrames ?? '',
      product.attempts
        .filter((attempt) => attempt.reservationState === 'settled')
        .reduce((total, attempt) => total + attempt.estimateCredits, 0),
      '',
      product.videoName ?? '',
      product.attempts.map((attempt) => attempt.jobId).filter(Boolean).join(' '),
      product.message,
      product.finishedAt ?? '',
    ].map(csvCell);
  });
  return [CSV_HEADER.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n';
}

export interface CatalogRunExport {
  app: 'BrandProof';
  schemaVersion: string;
  exportedAt: string;
  kind: 'catalog-run';
  run: {
    id: string;
    createdAt: string;
    finishedAt: string | null;
    status: CatalogRun['status'];
    config: CatalogRunConfig;
    serverBudgetCredits: number | null;
  };
  metrics: CatalogMetrics;
  cost: {
    source: 'estimate';
    note: string;
    estimatedCredits: number;
    actualCredits: null;
  };
  products: Array<
    Omit<CatalogProductJob, 'attempts'> & {
      attempts: CatalogAttempt[];
      report?: VerificationReport;
    }
  >;
  limitations: string[];
}

export const CATALOG_LIMITATIONS = [
  'BrandProof checks visible label text in sampled frames with OCR. It does not verify product shape, visual identity, ingredient claims, legal compliance or overall authenticity.',
  'Comfy Cloud API v2 does not report per-job credit usage, so every credit figure here is a planning estimate at the configured per-attempt rate, not provider billing.',
  'Generation concurrency is limited by this browser tab; the server enforces the spend and daily caps for every attempt it grants.',
  'A restored run can show stored evidence for attempts that finished, but not the removed video files or reference photos.',
];

export function runToExport(run: CatalogRun, reports: Map<string, VerificationReport>): CatalogRunExport {
  return {
    app: 'BrandProof',
    schemaVersion: 'catalog-pilot-1',
    exportedAt: new Date().toISOString(),
    kind: 'catalog-run',
    run: {
      id: run.id,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      status: run.status,
      config: run.config,
      serverBudgetCredits: run.serverBudgetCredits,
    },
    metrics: computeMetrics(run),
    cost: {
      source: 'estimate',
      note: 'Planning credits reserved per attempt by the BrandProof catalog ledger. Comfy Cloud does not expose per-job credit usage to this app, so actual billing must be read from the Comfy workspace.',
      estimatedCredits: computeMetrics(run).estimatedCredits,
      actualCredits: null,
    },
    products: run.products.map((product) => {
      const report = reports.get(product.id);
      return report ? { ...product, report } : { ...product };
    }),
    limitations: CATALOG_LIMITATIONS,
  };
}

export function runToExportJson(run: CatalogRun, reports: Map<string, VerificationReport>): string {
  return `${JSON.stringify(runToExport(run, reports), null, 2)}\n`;
}

export interface CatalogRunSnapshot {
  schemaVersion: 'catalog-snapshot-1';
  savedAt: string;
  run: CatalogRun;
  reportText: Record<string, string>;
}

/**
 * Persists everything that survives a reload. Files, object URLs and full frame
 * images cannot be serialised; the snapshot says so rather than pretending.
 */
export function toSnapshot(run: CatalogRun): CatalogRunSnapshot {
  return {
    schemaVersion: 'catalog-snapshot-1',
    savedAt: new Date().toISOString(),
    run,
    reportText: {},
  };
}

export function restoreFromSnapshot(snapshot: CatalogRunSnapshot): CatalogRun {
  const products = snapshot.run.products.map((product) => {
    if (isTerminal(product.status)) return product;
    const inFlight = product.attempts.find(
      (attempt) => attempt.reservationState === 'granted' && !attempt.finishedAt,
    );
    return {
      ...product,
      status: 'interrupted' as CatalogProductStatus,
      finishedAt: new Date().toISOString(),
      message: inFlight?.jobId
        ? `The page was reloaded during this product's run. No new generation was submitted. Comfy Cloud job ${inFlight.jobId} may still finish in the workspace; import its MP4 or rerun the catalog.`
        : 'The page was reloaded before this product reached a verdict. No new generation was submitted. Rerun the catalog to try it again.',
    };
  });
  return {
    ...snapshot.run,
    status: products.every((product) => isTerminal(product.status)) ? 'complete' : 'running',
    products,
  };
}
