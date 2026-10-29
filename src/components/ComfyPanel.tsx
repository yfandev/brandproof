import { useEffect, useRef, useState } from 'react';
import workflowTemplate from '../../comfy/workflows/wan22_ti2v_api.json?raw';
import {
  comfyDimensionsFor,
  generateVideo,
  parseWorkflow,
  testComfyConnection,
  type ComfyConnection,
  type GenerationEvent,
} from '../lib/comfy';
import { downloadText } from '../lib/report';
import { Alert, Pill } from './ui';

interface ComfyPanelProps {
  imageFile: File | null;
  imageWidth: number;
  imageHeight: number;
  prompt: string;
  negativePrompt: string;
  onGenerated: (blob: Blob, filename: string) => void;
}

type LogTone = 'info' | 'warn' | 'error' | 'success';

interface LogEntry {
  id: number;
  message: string;
  tone: LogTone;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8188';
const STORAGE_ENDPOINT = 'brandproof.comfy.endpoint';
const STORAGE_WORKFLOW = 'brandproof.comfy.workflow';
const GENERATION_FRAMES = 81;

function readStorage(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, quota); generation still works.
  }
}

function sanitizeFilename(name: string): string {
  const extension = /\.(png|jpe?g|webp|avif)$/i.exec(name)?.[0]?.toLowerCase() ?? '.png';
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `brandproof-${base || 'reference'}${extension}`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const TICK_LABELS: Record<string, string> = {
  queued: 'Queued in ComfyUI',
  generating: 'Generating frames',
  finalising: 'Writing the video file',
};

export function ComfyPanel({
  imageFile,
  imageWidth,
  imageHeight,
  prompt,
  negativePrompt,
  onGenerated,
}: ComfyPanelProps) {
  const [endpoint, setEndpoint] = useState(() => readStorage(STORAGE_ENDPOINT, DEFAULT_ENDPOINT));
  const [workflowText, setWorkflowText] = useState(() => readStorage(STORAGE_WORKFLOW, workflowTemplate));
  const [connection, setConnection] = useState<ComfyConnection | null>(null);
  const [testing, setTesting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [tickState, setTickState] = useState('starting');
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [promptId, setPromptId] = useState<string | null>(null);
  const logId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => writeStorage(STORAGE_ENDPOINT, endpoint), [endpoint]);
  useEffect(() => writeStorage(STORAGE_WORKFLOW, workflowText), [workflowText]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const appendLog = (message: string, tone: LogTone = 'info') => {
    logId.current += 1;
    setLogs((previous) => [...previous, { id: logId.current, message, tone }].slice(-40));
  };

  const handleTest = async () => {
    setTesting(true);
    setConnection(null);
    const result = await testComfyConnection(endpoint);
    setConnection(result);
    setTesting(false);
  };

  const handleGenerate = async () => {
    setError(null);
    setLogs([]);
    setElapsed(0);
    setPromptId(null);
    setQueuePosition(null);

    if (!imageFile) {
      setError('Add a product photo first — ComfyUI needs it as the start frame.');
      return;
    }
    if (!prompt.trim()) {
      setError('The generation prompt is empty. Rebuild it from the scene and brief.');
      return;
    }

    let workflow;
    try {
      workflow = parseWorkflow(workflowText);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'The workflow JSON is invalid.');
      return;
    }

    const dimensions = comfyDimensionsFor(imageWidth, imageHeight);
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setTickState('starting');

    try {
      const result = await generateVideo({
        baseUrl: endpoint,
        workflow,
        imageFile,
        imageFilename: sanitizeFilename(imageFile.name),
        positive: prompt,
        negative: negativePrompt,
        seed: Math.floor(Math.random() * 1_000_000_000),
        width: dimensions.width,
        height: dimensions.height,
        frames: GENERATION_FRAMES,
        signal: controller.signal,
        onEvent: (event: GenerationEvent) => {
          if (event.type === 'log') appendLog(event.message, event.tone ?? 'info');
          if (event.type === 'queued') setPromptId(event.promptId);
          if (event.type === 'tick') {
            setElapsed(event.elapsedMs);
            setTickState(event.state);
            setQueuePosition(event.queuePosition);
          }
          if (event.type === 'video') {
            appendLog('Clip downloaded and loaded into the player.', 'success');
            onGenerated(event.blob, event.filename);
          }
        },
      });
      setPromptId(result.promptId);
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : 'Generation failed.';
      setError(message);
      appendLog(message, 'error');
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="comfy">
      <div className="comfy__intro">
        <Pill tone="neutral">local GPU · advanced</Pill>
        <p>
          This advanced path calls a self-hosted{' '}
          <a href="https://docs.comfy.org/get_started/introduction" target="_blank" rel="noreferrer noopener">
            ComfyUI
          </a>{' '}
          server directly from this tab. For the primary no-install path, use the <strong>Comfy Cloud</strong> tab; it
          opens the real LTX-2.3 workflow and verifies the MP4 you bring back.
        </p>
      </div>

      <div className="comfy__endpoint">
        <label className="field__label" htmlFor="comfy-endpoint">
          ComfyUI endpoint
        </label>
        <div className="comfy__endpointrow">
          <input
            id="comfy-endpoint"
            className="input input--mono"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder={DEFAULT_ENDPOINT}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" className="btn btn--ghost" onClick={handleTest} disabled={testing || generating}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        <p className="field__hint">
          Start ComfyUI with <code>--enable-cors-header</code> so this origin can reach it. If you open BrandProof over
          HTTPS, an <code>http://127.0.0.1</code> endpoint may be blocked by the browser as mixed content.
        </p>
      </div>

      {connection && (
        <div className={`conn ${connection.ok ? 'conn--ok' : 'conn--bad'}`} role="status">
          <div className="conn__head">
            <Pill tone={connection.ok ? 'pass' : 'fail'} dot>
              {connection.ok ? 'connected' : 'unreachable'}
            </Pill>
            <span className="micro">{connection.version ? `v${connection.version}` : 'ComfyUI'}</span>
          </div>
          <p className="conn__message">{connection.message}</p>
          {connection.devices.length > 0 && (
            <ul className="conn__devices">
              {connection.devices.map((device) => (
                <li key={device}>{device}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <details className="advanced">
        <summary>
          Workflow · Wan 2.2 TI2V 5B <span className="micro">(API format, editable)</span>
        </summary>
        <div className="advanced__body">
          <p className="micro">
            BrandProof injects the prompt into <code>CLIPTextEncode</code> nodes, the product photo into{' '}
            <code>LoadImage</code>, seed into sampler nodes and resolution/frames into{' '}
            <code>Wan22ImageToVideoLatent</code>. Replace this with your own API-format workflow if you use different
            nodes.
          </p>
          <textarea
            className="input input--code"
            rows={12}
            value={workflowText}
            onChange={(event) => setWorkflowText(event.target.value)}
            spellCheck={false}
            aria-label="ComfyUI API workflow JSON"
          />
          <div className="advanced__actions">
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => setWorkflowText(workflowTemplate)}
              disabled={generating}
            >
              Reset to bundled template
            </button>
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => {
                try {
                  parseWorkflow(workflowText);
                  downloadText('brandproof-comfy-workflow.json', `${workflowText.trim()}\n`);
                } catch (parseError) {
                  setError(parseError instanceof Error ? parseError.message : 'Invalid workflow JSON.');
                }
              }}
            >
              Download workflow
            </button>
          </div>
          <p className="micro">
            Models required: <code>wan2.2_ti2v_5B_fp16.safetensors</code>, <code>wan2.2_vae.safetensors</code>,{' '}
            <code>umt5_xxl_fp8_e4m3fn_scaled.safetensors</code>. See the README for exact folders.
          </p>
        </div>
      </details>

      <div className="genbar">
        <button
          type="button"
          className="btn btn--primary btn--wide"
          onClick={handleGenerate}
          disabled={generating || testing || !imageFile}
          title={!imageFile ? 'Add a product photo first' : undefined}
        >
          {generating ? 'Generating in ComfyUI…' : 'Generate video'}
        </button>
        {generating && (
          <button type="button" className="btn btn--ghost" onClick={() => abortRef.current?.abort()}>
            Cancel
          </button>
        )}
        <span className="micro">
          {GENERATION_FRAMES} frames · {comfyDimensionsFor(imageWidth, imageHeight).width}×
          {comfyDimensionsFor(imageWidth, imageHeight).height} from your photo’s aspect · local GPU time varies
        </span>
      </div>

      {generating && (
        <div className="genstatus" aria-live="polite">
          <div className="genstatus__head">
            <span className="genstatus__state">{TICK_LABELS[tickState] ?? 'Talking to ComfyUI'}…</span>
            <span className="genstatus__time">{formatElapsed(elapsed)}</span>
          </div>
          <div className="genstatus__bar">
            <span />
          </div>
          <p className="micro">
            {promptId ? `Prompt ${promptId.slice(0, 8)}… · ` : ''}
            {queuePosition !== null ? `${queuePosition} in queue · ` : ''}
            Progress is polled from ComfyUI’s queue. Long generations are normal on a 5B video model.
          </p>
        </div>
      )}

      {logs.length > 0 && (
        <ol className="log">
          {logs.map((entry) => (
            <li key={entry.id} className={`log__line log__line--${entry.tone}`}>
              <span className="log__marker" aria-hidden="true" />
              <span>{entry.message}</span>
            </li>
          ))}
        </ol>
      )}

      {error && (
        <Alert tone="error" title="Generation did not complete">
          {error}
        </Alert>
      )}
    </div>
  );
}
