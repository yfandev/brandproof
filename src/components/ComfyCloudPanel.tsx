import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReferenceAsset } from '../types';
import {
  COMFY_API_DOCS,
  COMFY_API_KEYS_URL,
  CloudApiError,
  downloadCloudVideo,
  fetchComfyAccount,
  fetchComfyStatus,
  generateCloudVideo,
  parseWorkflowJson,
  waitForCloudVideo,
  type CloudJob,
  type ComfyAccount,
  type ComfyStatus,
} from '../lib/cloud';
import { DEFAULT_WORKFLOW_NAME, DEFAULT_WORKFLOW_TEXT } from '../lib/defaultWorkflow';
import { DEFAULT_NEGATIVE_PROMPT } from '../lib/scenes';
import { Alert, Pill } from './ui';

interface ComfyCloudPanelProps {
  product: ReferenceAsset | null;
  prompt: string;
  negativePrompt: string;
  brand: string;
  onCloudGenerated: (blob: Blob, filename: string) => void;
  onCloudImport: (file: File) => void;
}

type Phase = 'idle' | 'uploading' | 'queued' | 'running' | 'downloading' | 'done' | 'error';

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through.
  }
  return legacyCopy(text);
}

function money(amount: number, currency: string | null): string {
  const code = (currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'uploading':
      return 'Uploading photo to Comfy Cloud';
    case 'queued':
      return 'Queued on Comfy Cloud';
    case 'running':
      return 'Comfy Cloud is generating';
    case 'downloading':
      return 'Downloading the returned MP4';
    case 'done':
      return 'Returned MP4 loaded';
    case 'error':
      return 'Generation failed';
    default:
      return 'Ready';
  }
}

export function ComfyCloudPanel({
  product,
  prompt,
  negativePrompt,
  brand,
  onCloudGenerated,
  onCloudImport,
}: ComfyCloudPanelProps) {
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [account, setAccount] = useState<ComfyAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [job, setJob] = useState<CloudJob | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [bindings, setBindings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  const parsed = useMemo(() => parseWorkflowJson(DEFAULT_WORKFLOW_TEXT), []);
  const configured = status?.configured === true;
  const busy = phase === 'uploading' || phase === 'queued' || phase === 'running' || phase === 'downloading';

  useEffect(() => {
    const controller = new AbortController();
    void fetchComfyStatus(controller.signal)
      .then((next) => {
        setStatus(next);
        setStatusError(null);
      })
      .catch((next: unknown) => {
        if (controller.signal.aborted) return;
        setStatusError(
          next instanceof Error ? next.message : 'Could not read the Comfy Cloud configuration.',
        );
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // The key belongs to one Comfy workspace, so read that workspace's billing
  // rather than guessing whose credits a run spends.
  useEffect(() => {
    if (!configured) {
      setAccount(null);
      return;
    }
    const controller = new AbortController();
    void fetchComfyAccount(controller.signal)
      .then((next) => {
        setAccount(next);
        setAccountError(null);
      })
      .catch((next: unknown) => {
        if (controller.signal.aborted) return;
        setAccountError(
          next instanceof Error ? next.message : 'Could not read the Comfy Cloud billing workspace.',
        );
      });
    return () => controller.abort();
  }, [configured]);

  const handleCopyPrompt = async () => {
    if (!prompt.trim()) {
      setError('The prompt is empty. Add a brand or scene brief before copying.');
      return;
    }
    const ok = await copyText(prompt);
    if (!ok) {
      setError('The browser blocked clipboard access. Select the prompt text below and copy it manually.');
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleGenerate = async () => {
    if (!product) {
      setError('Upload a product photo in step 01 before generating.');
      return;
    }
    if (!parsed.ok) {
      setError(`The bundled workflow could not be converted: ${parsed.error}`);
      return;
    }
    if (!prompt.trim()) {
      setError('The generation prompt is empty.');
      return;
    }
    if (!configured) {
      setError('COMFY_API_KEY is not configured on the server. Add it in Settings → Secrets and redeploy.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('uploading');
    setError(null);
    setNotice(null);
    setJob(null);
    setBindings([]);
    setElapsedMs(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - started), 1000);

    try {
      const submitted = await generateCloudVideo({
        image: product.file,
        workflowText: parsed.parsed.apiWorkflowText,
        prompt,
        negative: negativePrompt || DEFAULT_NEGATIVE_PROMPT,
        idempotencyKey: crypto.randomUUID(),
        signal: controller.signal,
      });
      setBindings(submitted.bindings);
      setJob(submitted.job);
      setPhase(submitted.status === 'queued' ? 'queued' : 'running');

      const finished = await waitForCloudVideo(submitted.jobId, {
        signal: controller.signal,
        onJob: (next) => {
          setJob(next);
          if (next.status === 'running') setPhase('running');
          if (next.status === 'queued') setPhase('queued');
        },
      });

      setPhase('downloading');
      const video = await downloadCloudVideo(finished.id, controller.signal);
      const filename =
        video.filename || `comfy-cloud-${finished.id.slice(0, 8)}.mp4`;
      const file = new File([video.blob], filename, {
        type: video.blob.type || 'video/mp4',
      });
      onCloudGenerated(file, filename);
      setPhase('done');
      setNotice(`Comfy Cloud returned ${filename} · ${(video.blob.size / (1024 * 1024)).toFixed(1)} MB. Verification starts automatically.`);
    } catch (next) {
      if (next instanceof DOMException && next.name === 'AbortError') {
        setPhase('idle');
        setNotice('Stopped waiting. The Comfy Cloud job may still be running in your workspace.');
      } else {
        setPhase('error');
        setError(
          next instanceof CloudApiError
            ? next.message
            : next instanceof Error
              ? next.message
              : 'Comfy Cloud generation failed.',
        );
      }
    } finally {
      window.clearInterval(timer);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const progressValue =
    phase === 'done'
      ? 1
      : job?.progress?.value && Number.isFinite(job.progress.value)
        ? Math.max(0.02, Math.min(0.99, job.progress.value))
        : phase === 'queued'
          ? 0.04
          : phase === 'uploading'
            ? 0.02
            : phase === 'downloading'
              ? 0.99
              : 0;

  const missing = [
    !product ? 'product photo' : null,
    !parsed.ok ? 'a valid bundled workflow' : null,
    !prompt.trim() ? 'prompt' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="cloud">
      <div className="cloud__intro">
        <Pill tone="accent">Comfy Cloud · direct API</Pill>
        <div>
          <p className="cloud__lead">
            BrandProof submits its bundled LTX-2.3 image-to-video workflow to Comfy Cloud, injects the photo and
            prompt, polls the real job, and pulls the generated MP4 back for verification. No workflow upload, no
            manual Comfy tab and no file shuffling.
          </p>
          <p className="micro">
            The key stays in the Worker. BrandProof uses the documented Comfy{' '}
            <a href={COMFY_API_DOCS} target="_blank" rel="noreferrer noopener">
              API v2
            </a>{' '}
            and the LTX-2.3 workflow bundled with the app. Runs use the credits in your Comfy workspace.
          </p>
          <p className="micro">
            The photo is fitted into the workflow&apos;s 16:9 frame before upload, so Comfy&apos;s resize cannot crop
            the pack shot in half.
          </p>
        </div>
      </div>

      {statusError && (
        <Alert tone="warn" title="Could not read Comfy Cloud configuration">
          {statusError}
        </Alert>
      )}

      {configured && (
        <div className="cloud-account">
          <div className="cloud-account__head">
            <p className="field__label">Billing workspace</p>
            <Pill tone="neutral">{account?.workspaceName ?? 'workspace-scoped key'}</Pill>
          </div>
          <p className="micro">
            A Comfy API key always bills the workspace that created it, so this Worker cannot choose between your
            personal workspace and a team workspace at runtime.{' '}
            {account?.email ? `The key authenticates as ${account.email}.` : ''}
          </p>
          <div className="cloud-bindings">
            <span>workspace: {account?.workspaceName ?? 'not named by the API'}</span>
            {account?.balanceUsd != null && (
              <span>credit balance: {money(account.balanceUsd, account.currency)}</span>
            )}
            {account?.prepaidUsd != null && <span>prepaid: {money(account.prepaidUsd, account.currency)}</span>}
            {account?.cloudCreditUsd != null && (
              <span>cloud credit: {money(account.cloudCreditUsd, account.currency)}</span>
            )}
            {account?.spendUsd != null && <span>spent this month: {money(account.spendUsd, 'USD')}</span>}
          </div>
          {accountError && <p className="micro micro--warn">{accountError}</p>}
          {account?.warnings.map((warning) => (
            <p className="micro micro--warn" key={warning}>
              {warning}
            </p>
          ))}
        </div>
      )}

      {status && !configured && (
        <div className="cloud-setup">
          <div className="cloud-setup__copy">
            <p className="cloud-setup__title">Server key required</p>
            <p className="micro">
              Add a Comfy API key as a project secret so the Worker can submit jobs. Never put it in browser code.
            </p>
            <ol className="cloud__steps">
              <li>
                Open <strong>platform.comfy.org → API Keys</strong> and create a key for your SF Build Night workspace.
              </li>
              <li>
                In this project open <strong>Settings → Secrets</strong> and add <code>COMFY_API_KEY</code>.
              </li>
              <li>Redeploy so the Worker receives the secret, then reload this page.</li>
            </ol>
          </div>
          <a className="btn btn--ghost btn--sm" href={COMFY_API_KEYS_URL} target="_blank" rel="noreferrer noopener">
            Open API keys
          </a>
        </div>
      )}

      <div className="cloud-workflow">
        <div className="cloud-workflow__head">
          <div>
            <p className="field__label">Bundled Comfy workflow</p>
            <p className="micro">
              {DEFAULT_WORKFLOW_NAME} ships with BrandProof. It is converted to API format in the browser, then the
              Worker adds your photo and prompt before submitting the job. There is nothing to upload here.
            </p>
          </div>
          <Pill tone={parsed.ok ? 'pass' : 'fail'} dot={parsed.ok}>
            {parsed.ok ? 'workflow ready' : 'workflow error'}
          </Pill>
        </div>

        {parsed.ok ? (
          <>
            <div className="cloud-bindings">
              <span>{parsed.parsed.report.nodeCount} nodes</span>
              {parsed.parsed.report.convertedFromUi && <span>UI + subgraphs converted</span>}
              <span>photo → {parsed.parsed.report.imageNodes.join(', ')}</span>
              <span>prompt → {parsed.parsed.report.promptNodes.join(', ')}</span>
              <span>negative → {parsed.parsed.report.negativeNodes.join(', ') || 'not detected'}</span>
              <span>video → {parsed.parsed.report.outputNodes.join(', ')}</span>
            </div>
            {parsed.parsed.report.warnings.map((warning) => (
              <p className="micro micro--warn" key={warning}>
                {warning}
              </p>
            ))}
          </>
        ) : (
          <Alert tone="error" title="Bundled workflow could not be converted">
            {parsed.error}
          </Alert>
        )}
      </div>

      <div className="cloud__promptwrap">
        <div className="cloud__prompthead">
          <p className="field__label">Prepared prompt</p>
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => void handleCopyPrompt()}>
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </div>
        <pre className="cloud__prompt">{prompt || 'Add a brand or label brief in step 02 to build the prompt.'}</pre>
      </div>

      <div className="cloud-generate">
        <div className="cloud-generate__row">
          <div>
            <p className="cloud-generate__title">Generate with Comfy Cloud</p>
            <p className="micro">
              {missing.length > 0
                ? `Add ${missing.join(', ')} before generating.`
                : 'The Worker uploads the photo, submits the workflow, and downloads the returned MP4.'}
            </p>
          </div>
          <div className="cloud-generate__actions">
            {busy ? (
              <button type="button" className="btn btn--subtle btn--sm" onClick={handleStop}>
                Stop waiting
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleGenerate()}
              disabled={busy || !configured || missing.length > 0}
            >
              {busy ? 'Generating…' : phase === 'done' ? 'Generate again' : 'Generate with Comfy Cloud'}
            </button>
          </div>
        </div>

        {busy || phase === 'done' || phase === 'error' ? (
          <div className={`cloud-progress cloud-progress--${phase}`}>
            <div className="cloud-progress__top">
              <span>{phaseLabel(phase)}</span>
              <span className="mono">{elapsedLabel(elapsedMs)}</span>
            </div>
            <div className="cloud-progress__bar" aria-hidden="true">
              <span style={{ width: `${Math.round(progressValue * 100)}%` }} />
            </div>
            <div className="cloud-progress__facts">
              <span>{job ? `job ${job.id.slice(0, 12)}…` : 'submitting'}</span>
              {job?.queuePosition != null && <span>queue {job.queuePosition}</span>}
              {job?.progress?.step != null && job.progress.steps != null && (
                <span>
                  step {job.progress.step}/{job.progress.steps}
                </span>
              )}
              {job?.progress?.message && <span>{job.progress.message}</span>}
            </div>
          </div>
        ) : null}

        {bindings.length > 0 && (
          <details className="cloud-details">
            <summary>Injected workflow values</summary>
            <ul>
              {bindings.map((binding) => (
                <li key={binding}>{binding}</li>
              ))}
            </ul>
          </details>
        )}

        {notice && <p className="micro micro--accent">{notice}</p>}
        {error && (
          <Alert tone="error" title="Comfy Cloud generation">
            {error}
          </Alert>
        )}
      </div>

      <div className="cloud-return">
        <div className="cloud-return__copy">
          <p className="cloud-return__title">Already have an MP4?</p>
          <p className="micro">
            Import a clip generated anywhere. BrandProof loads the actual file and starts verification when a brand is
            set.
          </p>
        </div>
        <input
          ref={importRef}
          className="visually-hidden"
          type="file"
          accept="video/mp4,video/webm,video/ogg,video/quicktime"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onCloudImport(file);
            event.target.value = '';
          }}
          aria-label="Import an existing generated video"
        />
        <button type="button" className="btn btn--subtle" onClick={() => importRef.current?.click()}>
          Import MP4
        </button>
      </div>

      {!brand.trim() && (
        <p className="micro micro--warn">
          Add the exact brand name in step 02. Automatic verification needs it after the MP4 returns.
        </p>
      )}
    </div>
  );
}
