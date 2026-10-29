import { useEffect, useMemo, useRef, useState } from 'react';
import type { VerificationReport } from '../types';
import {
  DEFAULT_NEGATIVE_PROMPT,
  SCENES,
} from '../lib/scenes';
import { DEFAULT_WORKFLOW_TEXT } from '../lib/defaultWorkflow';
import { parseWorkflowJson, downloadCloudVideo, generateCloudVideo, waitForCloudVideo } from '../lib/cloud';
import {
  CATALOG_LIMITATIONS,
  DEFAULT_RUN_CONFIG,
  MAX_ATTEMPTS_PER_PRODUCT,
  STATUS_LABEL,
  buildCatalogPrompt,
  computeMetrics,
  createProductJob,
  emptyDraft,
  isTerminal,
  newCatalogId,
  restoreFromSnapshot,
  runToCsv,
  runToExportJson,
  toSnapshot,
  validateDrafts,
  validateRunConfig,
  type CatalogProductJob,
  type CatalogRun,
  type CatalogRunConfig,
  type CatalogRunSnapshot,
  type CatalogProductStatus,
} from '../lib/catalog';
import {
  CatalogApiError,
  createCatalogRun,
  fetchCatalogSettings,
  reserveCatalogAttempt,
  settleCatalogAttempt,
  type CatalogSettings,
} from '../lib/catalogApi';
import { runCatalog, type CatalogRuntimeProduct } from '../lib/catalogRunner';
import { verifyGeneratedClip } from '../lib/catalogVerify';
import { loadReferenceImage } from '../lib/image';
import { downloadText, reportToJson } from '../lib/report';
import { Alert, Field, Pill, type Tone } from './ui';

const SNAPSHOT_KEY = 'brandproof.catalog.snapshot.v1';

interface Row {
  id: string;
  name: string;
  brand: string;
  labelText: string;
  instructions: string;
  file: File | null;
  previewUrl: string | null;
  canvas: HTMLCanvasElement | null;
  error: string | null;
}

type Filter = 'all' | 'approved' | 'needs-review' | 'running' | 'budget-limited' | 'error';

const STATUS_TONE: Record<CatalogProductStatus, Tone> = {
  queued: 'neutral',
  generating: 'info',
  verifying: 'info',
  retrying: 'review',
  approved: 'pass',
  'needs-review': 'review',
  'budget-limited': 'review',
  error: 'fail',
  interrupted: 'fail',
};

function newRow(): Row {
  const draft = emptyDraft();
  return { ...draft, file: null, previewUrl: null, canvas: null, error: null };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'product';
}

function formatCredits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  return `${Math.round(value * 100) / 100} cr`;
}

function loadSnapshot(): CatalogRunSnapshot | null {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CatalogRunSnapshot;
    if (parsed?.schemaVersion !== 'catalog-snapshot-1' || !parsed.run?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readError(error: unknown): string {
  if (error instanceof CatalogApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
}

export function CatalogPanel() {
  const [settings, setSettings] = useState<CatalogSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const [config, setConfig] = useState<CatalogRunConfig>(() => ({
    ...DEFAULT_RUN_CONFIG,
    maxAttempts: MAX_ATTEMPTS_PER_PRODUCT,
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<CatalogRun | null>(null);
  const [restoredNotice, setRestoredNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const [clips, setClips] = useState<Record<string, { url: string; name: string }>>({});

  const reports = useRef(new Map<string, VerificationReport>());
  const runRef = useRef<CatalogRun | null>(null);
  const clipUrls = useRef<string[]>([]);

  const workflow = useMemo(() => parseWorkflowJson(DEFAULT_WORKFLOW_TEXT), []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCatalogSettings(controller.signal)
      .then((next) => {
        setSettings(next);
        setSettingsError(null);
        setConfig((previous) => ({
          ...previous,
          concurrency: Math.min(previous.concurrency, next.maxConcurrency),
          budgetCredits: Math.min(previous.budgetCredits, next.maxBudgetCredits),
          maxAttempts: next.retryLimit,
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettingsError(readError(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const snapshot = loadSnapshot();
    if (!snapshot) return;
    const restored = restoreFromSnapshot(snapshot);
    setRun(restored);
    runRef.current = restored;
    const unfinished = restored.products.filter((product) => product.status === 'interrupted').length;
    setRestoredNotice(
      unfinished > 0
        ? `Restored the last catalog run from this browser. ${unfinished} unfinished product${
            unfinished === 1 ? ' was' : 's were'
          } marked interrupted — no new generation was submitted for them.`
        : 'Restored the last completed catalog run from this browser.',
    );
  }, []);

  useEffect(() => {
    return () => {
      clipUrls.current.forEach((url) => URL.revokeObjectURL(url));
      rows.forEach((row) => {
        if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
      });
    };
    // Rows are released on explicit removal instead; unmount-only cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasImage = (id: string) => Boolean(rows.find((row) => row.id === id)?.file);
  const metrics = useMemo(() => (run ? computeMetrics(run) : null), [run]);

  const updateRow = (id: string, patch: Partial<Row>) => {
    setRows((previous) => previous.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const handleImage = async (id: string, file: File | null) => {
    if (!file) return;
    try {
      const loaded = await loadReferenceImage(file);
      const previous = rows.find((row) => row.id === id);
      if (previous?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
      updateRow(id, {
        file,
        previewUrl: loaded.url,
        canvas: loaded.canvas,
        error: null,
        name: previous?.name?.trim() ? previous.name : file.name.replace(/\.[^.]+$/, ''),
      });
    } catch (error) {
      updateRow(id, { file: null, previewUrl: null, canvas: null, error: readError(error) });
    }
  };

  const removeRow = (id: string) => {
    setRows((previous) => {
      const target = previous.find((row) => row.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return previous.length === 1 ? [newRow()] : previous.filter((row) => row.id !== id);
    });
  };

  const persist = (next: CatalogRun) => {
    try {
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(toSnapshot(next)));
    } catch {
      // Quota or privacy mode: the run still works in memory.
    }
  };

  const startRun = async () => {
    if (!settings) return;
    const problems = [
      ...validateDrafts(rows, hasImage),
      ...validateRunConfig({ ...config, maxAttempts: settings.retryLimit }),
    ];
    if (problems.length > 0) {
      setFormError(problems.join(' '));
      return;
    }
    if (!workflow.ok) {
      setFormError(`The bundled workflow could not be converted: ${workflow.error}`);
      return;
    }
    if (!settings.durable) {
      setFormError(
        'The catalog ledger is running in Worker memory on this deployment, so budget enforcement is per isolate. Ask the maintainer to bind CATALOG_DB before relying on the caps.',
      );
      return;
    }

    setStarting(true);
    setFormError(null);
    setRestoredNotice(null);
    try {
      const runId = newCatalogId('run');
      const ledger = await createCatalogRun({
        runId,
        budgetCredits: config.budgetCredits,
        concurrency: config.concurrency,
        productCount: rows.length,
      });

      clipUrls.current.forEach((url) => URL.revokeObjectURL(url));
      clipUrls.current = [];
      setClips({});
      reports.current.clear();

      const runConfig: CatalogRunConfig = {
        ...config,
        maxAttempts: settings.retryLimit,
      };
      const runtime = new Map<string, CatalogRuntimeProduct>();
      const products: CatalogProductJob[] = rows.map((row) => {
        runtime.set(row.id, {
          image: row.file as File,
          reference: row.canvas ? { canvas: row.canvas } : null,
          basePrompt: buildCatalogPrompt(
            {
              id: row.id,
              name: row.name,
              brand: row.brand,
              labelText: row.labelText,
              instructions: row.instructions,
            },
            runConfig,
          ),
        });
        return createProductJob({
          id: row.id,
          name: row.name,
          brand: row.brand,
          labelText: row.labelText,
          instructions: row.instructions,
        });
      });

      const nextRun: CatalogRun = {
        id: runId,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        status: 'running',
        config: runConfig,
        serverBudgetCredits: ledger.run.budgetCredits,
        products,
      };
      runRef.current = nextRun;
      setRun(nextRun);
      setConfirming(false);
      setFilter('all');
      persist(nextRun);

      await runCatalog({
        run: nextRun,
        runtime,
        onUpdate: (next) => {
          runRef.current = next;
          setRun(next);
          persist(next);
        },
        deps: {
          reserve: async ({ runId: id, attemptId, productId }) => {
            const result = await reserveCatalogAttempt({ runId: id, attemptId, productId });
            return {
              granted: result.granted,
              reason: result.reason,
              credits: result.reservation.credits,
            };
          },
          settle: async ({ runId: id, attemptId, outcome }) => {
            await settleCatalogAttempt({ runId: id, attemptId, outcome });
          },
          generate: async ({ image, prompt, attemptId, onJobId }) => {
            const submitted = await generateCloudVideo({
              image,
              workflowText: workflow.ok ? workflow.parsed.apiWorkflowText : '',
              prompt,
              negative: DEFAULT_NEGATIVE_PROMPT,
              idempotencyKey: attemptId,
            });
            onJobId(submitted.jobId);
            const finished = await waitForCloudVideo(submitted.jobId, { onJob: () => undefined });
            const video = await downloadCloudVideo(finished.id);
            return { blob: video.blob, filename: video.filename, jobId: finished.id };
          },
          verify: async ({ blob, filename, product, job }) => {
            const active = runRef.current;
            if (!active) throw new Error('The run was closed before verification started.');
            const report = await verifyGeneratedClip({
              blob,
              filename,
              product,
              brand: job.brand,
              labelText: job.labelText,
              config: active.config,
              onProgress: (progress) => {
                setVerifyNote(`${job.name} · ${progress.message}`);
              },
            });
            reports.current.set(job.id, report);
            setVerifyNote(null);
            return report;
          },
          onClip: ({ productId, blob, filename }) => {
            const url = URL.createObjectURL(blob);
            clipUrls.current.push(url);
            setClips((previous) => {
              const prior = previous[productId];
              if (prior) URL.revokeObjectURL(prior.url);
              return { ...previous, [productId]: { url, name: filename } };
            });
          },
        },
      });
    } catch (error) {
      setFormError(readError(error));
    } finally {
      setStarting(false);
    }
  };

  const downloadProductJson = (job: CatalogProductJob) => {
    const full = reports.current.get(job.id);
    const filename = `brandproof-catalog-${slug(job.name)}-${job.id.slice(-6)}.json`;
    if (full) {
      downloadText(filename, reportToJson(full));
      return;
    }
    const payload = {
      app: 'BrandProof',
      schemaVersion: 'catalog-product-1',
      exportedAt: new Date().toISOString(),
      note: 'This product row was restored from browser storage, so the original MP4, reference photo and frame images are no longer available. The recorded OCR evidence is reproduced exactly as stored.',
      product: {
        id: job.id,
        name: job.name,
        brand: job.brand,
        labelText: job.labelText,
        status: job.status,
        message: job.message,
        approvedAttemptId: job.approvedAttemptId,
      },
      attempts: job.attempts,
      evidence: job.evidence,
      limitations: CATALOG_LIMITATIONS,
    };
    downloadText(filename, `${JSON.stringify(payload, null, 2)}\n`);
  };

  const visibleProducts = useMemo(() => {
    if (!run) return [];
    return run.products.filter((product) => {
      if (filter === 'all') return true;
      if (filter === 'approved') return product.status === 'approved';
      if (filter === 'needs-review') return product.status === 'needs-review';
      if (filter === 'budget-limited') return product.status === 'budget-limited';
      if (filter === 'error') return product.status === 'error' || product.status === 'interrupted';
      return !isTerminal(product.status);
    });
  }, [run, filter]);

  const busy = run?.status === 'running' || starting;

  return (
    <section className="cat">
      <div className="cat__intro">
        <Pill tone="accent">Catalog pilot · parallel</Pill>
        <div>
          <h2 className="cat__title">Run a label-fidelity pilot across a catalog</h2>
          <p className="cat__lede">
            Add up to {settings?.maxProducts ?? 8} products, then BrandProof generates a clip per product through the
            bundled LTX-2.3 workflow on Comfy Cloud and verifies each returned MP4 with the same OCR evidence the studio
            uses. Products run concurrently up to the concurrency limit; every attempt reserves budget on the server
            before it starts.
          </p>
          <p className="cat__lede">
            Failing products are retried automatically. When an attempt comes back <strong>FAIL</strong> or{' '}
            <strong>REVIEW</strong>, BrandProof reads that attempt&apos;s own OCR evidence, rewrites the prompt to target
            what the evidence actually showed, and regenerates the clip — up to{' '}
            {settings?.retryLimit ?? MAX_ATTEMPTS_PER_PRODUCT} total attempts per product. A product that still has no
            genuine PASS after the last attempt is marked <strong>Needs human review</strong>; REVIEW never counts as
            approval.
          </p>
          <details className="cat-notes">
            <summary>How the automatic retry loop works</summary>
            <ol>
              <li>Generate a clip for the product with the bundled LTX-2.3 workflow on Comfy Cloud.</li>
              <li>Verify the returned MP4 with the studio&apos;s OCR pipeline and record each attempt&apos;s verdict and token evidence.</li>
              <li>
                On a genuine PASS the product is approved and never regenerated. On FAIL or REVIEW, build a revision from
                the recorded findings — text not detected → front-facing, larger, slower camera; lettering visibly
                distorted → rigid packaging, locked-off camera; label unreadable → closer, unobstructed, evenly lit — and
                regenerate with that revision appended to the prompt.
              </li>
              <li>
                Stop at {settings?.retryLimit ?? MAX_ATTEMPTS_PER_PRODUCT} attempts, or earlier if the run budget cannot
                cover another one, and mark the product for human review. Every attempt keeps its prompt, revision basis,
                verdict, frame evidence, job id and reservation.
              </li>
            </ol>
          </details>
          <p className="micro">
            BrandProof checks visible label text only. It does not verify product shape, ingredients, legal claims or
            overall authenticity. Comfy Cloud does not report per-job credit usage, so every credit figure is a planning
            estimate.
          </p>
        </div>
      </div>

      {settingsError && (
        <Alert tone="warn" title="Could not read catalog limits">
          {settingsError}
        </Alert>
      )}

      {settings && (
        <div className="cat-ledger">
          <div className="cat-ledger__row">
            <span className={`cat-dot cat-dot--${settings.durable ? 'pass' : 'review'}`} aria-hidden="true" />
            <strong>{settings.durable ? 'D1 ledger connected' : 'Memory ledger only'}</strong>
            <span className="micro">
              {settings.durable
                ? 'Budget reservations and the daily cap are stored server-side and shared by every Worker isolate.'
                : 'CATALOG_DB is not bound on this deployment. Budget reservations live in Worker memory, per isolate, and reset on redeploy. The run form refuses to start until this is fixed.'}
            </span>
          </div>
          <div className="cat-ledger__facts">
            <span>attempts / product: {settings.retryLimit}</span>
            <span>max concurrency: {settings.maxConcurrency}</span>
            <span>estimate / attempt: {formatCredits(settings.estimateCreditsPerAttempt)}</span>
            <span>reserved / attempt: {formatCredits(settings.reservationCredits)}</span>
            <span>daily cap: {formatCredits(settings.dailyCapCredits)}</span>
            <span>daily left: {formatCredits(settings.dailyRemainingCredits)}</span>
            <span>max run budget: {formatCredits(settings.maxBudgetCredits)}</span>
          </div>
          <details className="cat-notes">
            <summary>How these limits are enforced</summary>
            <ul>
              {settings.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {restoredNotice && (
        <Alert tone="info" title="Previous run restored">
          {restoredNotice}
        </Alert>
      )}

      <div className="cat-grid">
        <div className="cat-intake">
          <div className="cat-intake__head">
            <h3>Products</h3>
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              disabled={busy || rows.length >= (settings?.maxProducts ?? 8)}
              onClick={() => setRows((previous) => [...previous, newRow()])}
            >
              Add product
            </button>
          </div>

          {rows.map((row, index) => (
            <article className="cat-row" key={row.id}>
              <header className="cat-row__head">
                <span className="cat-row__index">{String(index + 1).padStart(2, '0')}</span>
                <h4>{row.name.trim() || 'Untitled product'}</h4>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => removeRow(row.id)}
                  disabled={busy}
                >
                  Remove
                </button>
              </header>

              <div className="cat-row__body">
                <label className="cat-thumb">
                  {row.previewUrl ? (
                    <img src={row.previewUrl} alt={`${row.name || 'Product'} reference`} />
                  ) : (
                    <span>Add photo</span>
                  )}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/avif"
                    className="visually-hidden"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      void handleImage(row.id, file);
                      event.target.value = '';
                    }}
                  />
                </label>

                <div className="cat-row__fields">
                  <Field label="Product name" htmlFor={`${row.id}-name`}>
                    <input
                      id={`${row.id}-name`}
                      className="input"
                      value={row.name}
                      disabled={busy}
                      onChange={(event) => updateRow(row.id, { name: event.target.value })}
                      placeholder="Botanika Hydrating Moisturizer"
                    />
                  </Field>
                  <Field label="Brand" htmlFor={`${row.id}-brand`}>
                    <input
                      id={`${row.id}-brand`}
                      className="input"
                      value={row.brand}
                      disabled={busy}
                      onChange={(event) => updateRow(row.id, { brand: event.target.value })}
                      placeholder="BOTANIKA"
                    />
                  </Field>
                  <Field label="Required label lines" hint="One check per line." htmlFor={`${row.id}-label`}>
                    <textarea
                      id={`${row.id}-label`}
                      className="textarea textarea--sm"
                      rows={3}
                      value={row.labelText}
                      disabled={busy}
                      onChange={(event) => updateRow(row.id, { labelText: event.target.value })}
                      placeholder={'HYDRATING\nMOISTURIZER'}
                    />
                  </Field>
                  <Field label="Extra direction" htmlFor={`${row.id}-instructions`} optional>
                    <input
                      id={`${row.id}-instructions`}
                      className="input"
                      value={row.instructions}
                      disabled={busy}
                      onChange={(event) => updateRow(row.id, { instructions: event.target.value })}
                      placeholder="Show the front label on a plinth"
                    />
                  </Field>
                </div>
              </div>
              {row.error && <p className="micro micro--warn">{row.error}</p>}
            </article>
          ))}

          <div className="cat-config">
            <Field label="Scene">
              <div className="cat-scenes">
                {SCENES.map((scene) => (
                  <button
                    type="button"
                    key={scene.id}
                    className={`cat-scene ${config.scene === scene.id ? 'cat-scene--active' : ''}`}
                    disabled={busy}
                    onClick={() => setConfig((previous) => ({ ...previous, scene: scene.id }))}
                  >
                    <strong>{scene.name}</strong>
                    <em>{scene.blurb}</em>
                  </button>
                ))}
              </div>
            </Field>

            <div className="cat-config__row">
              <Field label="Concurrent products" hint={`1–${settings?.maxConcurrency ?? 4}`}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={settings?.maxConcurrency ?? 4}
                  value={config.concurrency}
                  disabled={busy}
                  onChange={(event) =>
                    setConfig((previous) => ({
                      ...previous,
                      concurrency: Number(event.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="Run budget (estimated credits)" hint="Server-enforced per attempt">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={settings?.maxBudgetCredits ?? 40}
                  step={0.5}
                  value={config.budgetCredits}
                  disabled={busy}
                  onChange={(event) =>
                    setConfig((previous) => ({
                      ...previous,
                      budgetCredits: Number(event.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="Frames sampled / clip">
                <input
                  className="input"
                  type="number"
                  min={4}
                  max={24}
                  value={config.sampleCount}
                  disabled={busy}
                  onChange={(event) =>
                    setConfig((previous) => ({
                      ...previous,
                      sampleCount: Number(event.target.value),
                    }))
                  }
                />
              </Field>
            </div>
          </div>

          {formError && (
            <Alert tone="error" title="Catalog run blocked">
              {formError}
            </Alert>
          )}

          {confirming ? (
            <div className="cat-confirm">
              <p className="cat-confirm__title">Start catalog run?</p>
              <dl className="cat-confirm__list">
                <div>
                  <dt>Products</dt>
                  <dd>{rows.length}</dd>
                </div>
                <div>
                  <dt>Max attempts per product</dt>
                  <dd>{settings?.retryLimit ?? MAX_ATTEMPTS_PER_PRODUCT} (including the first)</dd>
                </div>
                <div>
                  <dt>Parallel products</dt>
                  <dd>{config.concurrency} at once</dd>
                </div>
                <div>
                  <dt>Run budget</dt>
                  <dd>{formatCredits(config.budgetCredits)} estimated</dd>
                </div>
                <div>
                  <dt>Reserved per attempt</dt>
                  <dd>{formatCredits(settings?.reservationCredits ?? 1)} (incl. safety margin)</dd>
                </div>
                <div>
                  <dt>Daily credits left</dt>
                  <dd>{formatCredits(settings?.dailyRemainingCredits ?? null)}</dd>
                </div>
              </dl>
              <p className="micro">
                Every attempt reserves budget on the server before generation, so concurrent products cannot spend the
                same credits. A product that comes back FAIL or REVIEW is regenerated automatically with a prompt
                revision built from that attempt&apos;s OCR evidence, up to {settings?.retryLimit ?? 3} total attempts,
                then marked for human review. REVIEW is never approval.
              </p>
              <div className="cat-confirm__actions">
                <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={starting || !settings?.durable}
                  onClick={() => void startRun()}
                >
                  {starting ? 'Starting…' : 'Confirm and start'}
                </button>
              </div>
            </div>
          ) : (
            <div className="cat-start">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !settings}
                onClick={() => {
                  const problems = [
                    ...validateDrafts(rows, hasImage),
                    ...validateRunConfig(config),
                  ];
                  if (problems.length > 0) {
                    setFormError(problems.join(' '));
                    setConfirming(false);
                    return;
                  }
                  setFormError(null);
                  setConfirming(true);
                }}
              >
                Start catalog run
              </button>
              <span className="micro">Nothing is sent to Comfy Cloud until you confirm.</span>
            </div>
          )}
        </div>

        <aside className="cat-board">
          {!run && (
            <div className="cat-empty">
              <p className="cat-empty__title">No run yet</p>
              <p className="micro">
                Add products and start a run. Each returned MP4 is verified independently by OCR here, and every
                attempt&apos;s evidence stays inspectable and exportable.
              </p>
            </div>
          )}

          {run && metrics && (
            <>
              <div className="cat-metrics">
                <div className="cat-metric">
                  <span>Progress</span>
                  <strong>
                    {metrics.completedProducts}/{metrics.submitted}
                  </strong>
                </div>
                <div className="cat-metric">
                  <span>Approved</span>
                  <strong>{metrics.approved}</strong>
                </div>
                <div className="cat-metric">
                  <span>Needs review</span>
                  <strong>{metrics.needsReview}</strong>
                </div>
                <div className="cat-metric">
                  <span>Budget limited</span>
                  <strong>{metrics.budgetLimited}</strong>
                </div>
                <div className="cat-metric">
                  <span>Errors</span>
                  <strong>{metrics.errors + metrics.interrupted}</strong>
                </div>
                <div className="cat-metric">
                  <span>Attempts</span>
                  <strong>{metrics.attempts}</strong>
                </div>
                <div className="cat-metric">
                  <span>Approval rate</span>
                  <strong>
                    {metrics.approvalRate === null ? 'N/A' : `${Math.round(metrics.approvalRate * 100)}%`}
                  </strong>
                </div>
                <div className="cat-metric">
                  <span>Estimated credits</span>
                  <strong>{formatCredits(metrics.estimatedCredits)}</strong>
                </div>
                <div className="cat-metric">
                  <span>Cost / approved clip</span>
                  <strong>{formatCredits(metrics.costPerApprovedClip)}</strong>
                </div>
              </div>
              <p className="micro">
                {run.status === 'running'
                  ? `Live metrics for this run · ${metrics.completedProducts} of ${metrics.submitted} products finished.`
                  : `Final metrics for this run · all ${metrics.submitted} products reached a terminal state.`}{' '}
                Credits are planning estimates from the ledger, not Comfy billing.
              </p>
              {verifyNote && <p className="micro micro--accent">{verifyNote}</p>}

              <div className="cat-toolbar">
                <div className="cat-filters" role="group" aria-label="Filter products">
                  {(
                    [
                      ['all', 'All'],
                      ['approved', 'Approved'],
                      ['needs-review', 'Needs review'],
                      ['running', 'Running'],
                      ['budget-limited', 'Budget limited'],
                      ['error', 'Error'],
                    ] as Array<[Filter, string]>
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={`cat-filter ${filter === value ? 'cat-filter--active' : ''}`}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="cat-exports">
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={() =>
                      downloadText(`brandproof-catalog-${run.id.slice(-8)}.csv`, runToCsv(run), 'text/csv')
                    }
                  >
                    CSV
                  </button>
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={() =>
                      downloadText(
                        `brandproof-catalog-${run.id.slice(-8)}.json`,
                        runToExportJson(run, reports.current),
                      )
                    }
                  >
                    Batch JSON
                  </button>
                </div>
              </div>

              <div className="cat-cards">
                {visibleProducts.map((product) => {
                  const clip = clips[product.id];
                  const isOpen = expanded === product.id;
                  return (
                    <article className="cat-card" key={product.id}>
                      <header className="cat-card__head">
                        <Pill tone={STATUS_TONE[product.status]} dot>
                          {STATUS_LABEL[product.status]}
                        </Pill>
                        <div className="cat-card__title">
                          <strong>{product.name}</strong>
                          <span className="micro">{product.brand}</span>
                        </div>
                        <span className="cat-card__attempts">
                          {product.attempts.length}/{run.config.maxAttempts} attempts
                        </span>
                      </header>

                      <div className="cat-card__body">
                        <div className="cat-card__media">
                          {clip ? (
                            <video src={clip.url} controls playsInline preload="metadata" />
                          ) : (
                            <div className="cat-card__placeholder">
                              {product.videoName ? `Video: ${product.videoName}` : 'No clip yet'}
                            </div>
                          )}
                        </div>
                        <div className="cat-card__info">
                          <p className="cat-card__message">{product.message}</p>
                          {product.evidence && (
                            <ul className="cat-tokens">
                              {product.evidence.tokenEvidence.slice(0, 6).map((entry) => (
                                <li key={`${entry.kind}-${entry.token}`}>
                                  <span className={`cat-token cat-token--${entry.finding}`}>
                                    {entry.finding === 'verified' || entry.finding === 'detected'
                                      ? '✓'
                                      : entry.finding === 'not-detected'
                                        ? '×'
                                        : '!'}
                                  </span>
                                  <span>{entry.token}</span>
                                  <em className="micro">
                                    {entry.finding.replace(/-/g, ' ')}
                                    {entry.bestReading ? ` · read “${entry.bestReading}”` : ''}
                                  </em>
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="cat-card__actions">
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => setExpanded(isOpen ? null : product.id)}
                              aria-expanded={isOpen}
                            >
                              {isOpen ? 'Hide evidence' : 'Evidence'}
                            </button>
                            <button
                              type="button"
                              className="btn btn--subtle btn--sm"
                              onClick={() => downloadProductJson(product)}
                            >
                              JSON
                            </button>
                          </div>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="cat-evidence">
                          {product.attempts.length === 0 && (
                            <p className="micro">No generation attempt was made for this product.</p>
                          )}
                          {product.attempts.map((attempt) => (
                            <div className="cat-attempt" key={attempt.id}>
                              <header className="cat-attempt__head">
                                <strong>Attempt {attempt.index}</strong>
                                {attempt.verdict && (
                                  <Pill
                                    tone={
                                      attempt.verdict === 'PASS'
                                        ? 'pass'
                                        : attempt.verdict === 'FAIL'
                                          ? 'fail'
                                          : 'review'
                                    }
                                  >
                                    {attempt.verdict}
                                  </Pill>
                                )}
                                <span className="micro">
                                  {attempt.reservationState ?? 'no reservation'} ·{' '}
                                  {formatCredits(attempt.estimateCredits)}
                                </span>
                              </header>
                              <p className="micro">
                                {attempt.jobId ? `Comfy job ${attempt.jobId}` : 'No Comfy job id recorded'} ·{' '}
                                {attempt.videoName ?? 'no video'} ·{' '}
                                {attempt.finishedAt ?? 'still running'}
                              </p>
                              <p className="cat-attempt__adjustment">
                                <strong>Revision:</strong> {attempt.adjustment ?? 'Initial prompt, no revision.'}
                              </p>
                              {attempt.adjustmentReason && (
                                <p className="micro">Basis: {attempt.adjustmentReason}</p>
                              )}
                              {attempt.error && <p className="micro micro--warn">{attempt.error}</p>}
                              {attempt.evidence && (
                                <>
                                  <p className="micro">
                                    {attempt.evidence.headline} · {attempt.evidence.metrics.sampledFrames} frames
                                    sampled, {attempt.evidence.metrics.readableFrames} readable, mean confidence{' '}
                                    {attempt.evidence.metrics.meanConfidence.toFixed(1)}
                                  </p>
                                  <ul className="cat-checks">
                                    {attempt.evidence.checks.map((check) => (
                                      <li key={check.id}>
                                        <span className={`cat-check cat-check--${check.status}`}>
                                          {check.status}
                                        </span>
                                        <span>{check.title}</span>
                                        <em className="micro">{check.detail}</em>
                                      </li>
                                    ))}
                                  </ul>
                                  <details className="cat-frames">
                                    <summary>Per-frame OCR text ({attempt.evidence.frames.length})</summary>
                                    <table>
                                      <thead>
                                        <tr>
                                          <th>#</th>
                                          <th>t</th>
                                          <th>status</th>
                                          <th>conf</th>
                                          <th>recognised text</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {attempt.evidence.frames.map((frame) => (
                                          <tr key={frame.index}>
                                            <td>{frame.index + 1}</td>
                                            <td>{frame.time.toFixed(2)}s</td>
                                            <td>{frame.status}</td>
                                            <td>{frame.meanConfidence.toFixed(0)}</td>
                                            <td>{frame.text || '—'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </details>
                                </>
                              )}
                            </div>
                          ))}
                          <details className="cat-prompt">
                            <summary>Prompt used on the last attempt</summary>
                            <pre>{product.attempts[product.attempts.length - 1]?.prompt ?? '—'}</pre>
                          </details>
                        </div>
                      )}
                    </article>
                  );
                })}
                {visibleProducts.length === 0 && (
                  <p className="micro">No products match this filter.</p>
                )}
              </div>

              <p className="micro cat-disclaimer">
                Automated label-text consistency check on sampled frames — evidence, not a guarantee that the product is
                identical in every frame. {CATALOG_LIMITATIONS[2]}
              </p>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
