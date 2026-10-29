import { convertUiWorkflow } from './workflowConvert';

export const LTX23_WORKFLOW_PAGE =
  'https://comfy.org/workflows/video_ltx2_3_i2v-7cc1d3bd2802/';
export const COMFY_WORKFLOW_FORMAT_DOCS =
  'https://docs.comfy.org/development/api-development/workflow-api-format';
export const COMFY_API_DOCS = 'https://docs.comfy.org/api-reference/v2/overview';
export const COMFY_API_KEYS_URL = 'https://platform.comfy.org';

const MAX_WORKFLOW_BYTES = 2_000_000;
const VIDEO_NODE_CLASSES = new Set(['SaveVideo', 'SaveWEBM', 'VHS_VideoCombine']);

export interface CloudWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export interface CloudWorkflowReport {
  nodeCount: number;
  promptNodes: string[];
  negativeNodes: string[];
  imageNodes: string[];
  outputNodes: string[];
  warnings: string[];
  convertedFromUi?: boolean;
}

export interface ParsedCloudWorkflow {
  workflow: Record<string, CloudWorkflowNode>;
  apiWorkflowText: string;
  report: CloudWorkflowReport;
}

export type CloudWorkflowParseResult =
  | { ok: true; parsed: ParsedCloudWorkflow }
  | { ok: false; error: string };

/**
 * Validates an API-format workflow in the browser so the user gets a useful
 * error before uploading anything. The Worker validates it again.
 */
export function parseWorkflowJson(text: string): CloudWorkflowParseResult {
  if (!text.trim()) {
    return { ok: false, error: 'Load an API-format workflow JSON before generating.' };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_BYTES) {
    return { ok: false, error: 'The workflow JSON is larger than 2 MB.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `The workflow JSON could not be parsed: ${
        error instanceof Error ? error.message : 'invalid JSON'
      }.`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The workflow must be a JSON object in Comfy API or UI format.' };
  }

  let workflow: Record<string, CloudWorkflowNode> = {};
  let conversionWarnings: string[] = [];
  let convertedFromUi = false;

  if (Array.isArray((parsed as { nodes?: unknown }).nodes)) {
    // Comfy Cloud's ordinary Export produces UI format. Flatten subgraphs and
    // convert linked inputs so it can be submitted as an API workflow.
    try {
      const converted = convertUiWorkflow(parsed);
      workflow = converted.workflow;
      conversionWarnings = converted.warnings;
      convertedFromUi = true;
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'The UI workflow could not be converted to API format.',
      };
    }
  } else {
    for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: `Workflow node ${id} is not an object.` };
      }
      const node = raw as { class_type?: unknown; inputs?: unknown; _meta?: unknown };
      if (typeof node.class_type !== 'string' || !node.class_type) {
        return { ok: false, error: `Workflow node ${id} is missing "class_type".` };
      }
      if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
        return { ok: false, error: `Workflow node ${id} is missing an "inputs" object.` };
      }
      workflow[id] = {
        class_type: node.class_type,
        inputs: { ...(node.inputs as Record<string, unknown>) },
        ...(node._meta && typeof node._meta === 'object'
          ? { _meta: { ...(node._meta as { title?: string }) } }
          : {}),
      };
    }
  }

  const entries = Object.entries(workflow);
  if (entries.length === 0) return { ok: false, error: 'The workflow JSON is empty.' };

  // CLIPTextEncode may have a linked prompt input (for example a prompt-enhancer
  // node). We still need its widget to replace, so match the node class too.
  const textNodes = entries.filter(
    ([, node]) => typeof node.inputs.text === 'string' || /CLIPTextEncode/i.test(node.class_type),
  );
  if (textNodes.length === 0) {
    return {
      ok: false,
      error:
        'This workflow has no text prompt input (a node with an "inputs.text" string). The BrandProof prompt cannot be applied safely.',
    };
  }

  const negativeNodes = textNodes.filter(([, node]) => /neg/i.test(node._meta?.title ?? ''));
  const positiveNodes = textNodes.filter(
    ([id]) => !negativeNodes.some(([negativeId]) => negativeId === id),
  );
  const promptNodes = positiveNodes.length > 0 ? positiveNodes : textNodes;

  const imageNodes = entries.filter(
    ([, node]) =>
      node.class_type === 'LoadImage' ||
      (typeof node.inputs.image === 'string' && /loadimage/i.test(node.class_type)),
  );
  if (imageNodes.length === 0) {
    return {
      ok: false,
      error:
        'This workflow has no LoadImage node, so it cannot use the product photo. Add one and export the API workflow again.',
    };
  }

  const outputNodes = entries.filter(([, node]) => VIDEO_NODE_CLASSES.has(node.class_type));
  if (outputNodes.length === 0) {
    return {
      ok: false,
      error:
        'This workflow has no SaveVideo (or compatible video output) node. BrandProof can only verify a real video file.',
    };
  }

  const warnings = [...conversionWarnings];
  if (negativeNodes.length === 0) {
    warnings.push('No negative-prompt node was detected by title; the negative prompt will not be applied.');
  }

  return {
    ok: true,
    parsed: {
      workflow,
      apiWorkflowText: JSON.stringify(workflow),
      report: {
        nodeCount: entries.length,
        promptNodes: promptNodes.map(([id]) => id),
        negativeNodes: negativeNodes.map(([id]) => id),
        imageNodes: imageNodes.map(([id]) => id),
        outputNodes: outputNodes.map(([id]) => id),
        warnings,
        convertedFromUi,
      },
    },
  };
}

export class CloudApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, { code = 'comfy_error', status = 0 } = {}) {
    super(message);
    this.name = 'CloudApiError';
    this.code = code;
    this.status = status;
  }
}

export interface ComfyStatus {
  configured: boolean;
  provider: string;
  api: string;
  workflowRequired: boolean;
}

export interface CloudJobOutput {
  id: string;
  name: string;
  type: string;
  contentType: string;
  sizeBytes: number | null;
}

export interface CloudJobProgress {
  value: number | null;
  nodesDone: number | null;
  nodesTotal: number | null;
  step: number | null;
  steps: number | null;
  message: string | null;
}

export interface CloudJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'canceling' | 'canceled' | 'failed' | 'expired' | string;
  queuePosition: number | null;
  progress: CloudJobProgress | null;
  outputs: CloudJobOutput[];
  error: {
    code: string;
    message: string;
    nodeId: string | null;
    classType: string | null;
  } | null;
}

export interface CloudGenerateResponse {
  jobId: string;
  status: string;
  job: CloudJob;
  asset: { name: string };
  bindings: string[];
  workflow: CloudWorkflowReport;
}

export interface CloudGenerateInput {
  image: File;
  workflowText: string;
  prompt: string;
  negative: string;
  seed?: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}

async function errorFromResponse(response: Response): Promise<CloudApiError> {
  let payload: { error?: { code?: string; message?: string } } | null = null;
  try {
    payload = (await response.json()) as { error?: { code?: string; message?: string } };
  } catch {
    // Fall through to a status-based message.
  }
  const message =
    payload?.error?.message ||
    (response.status === 401
      ? 'The Comfy Cloud API key was rejected.'
      : `The Comfy Cloud request failed (HTTP ${response.status}).`);
  return new CloudApiError(message, {
    code: payload?.error?.code || `http_${response.status}`,
    status: response.status,
  });
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(init.headers || {}) },
    });
  } catch (error) {
    if (init.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    throw new CloudApiError(
      `Could not reach BrandProof's Comfy Cloud proxy: ${
        error instanceof Error ? error.message : 'network error'
      }.`,
      { code: 'proxy_unreachable' },
    );
  }
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as T;
}

export async function fetchComfyStatus(signal?: AbortSignal): Promise<ComfyStatus> {
  const data = await requestJson<{
    configured?: boolean;
    provider?: string;
    api?: string;
    workflowRequired?: boolean;
  }>('/api/comfy/status', { signal });
  return {
    configured: Boolean(data.configured),
    provider: data.provider || 'Comfy Cloud',
    api: data.api || 'v2',
    workflowRequired: Boolean(data.workflowRequired),
  };
}

export async function generateCloudVideo(input: CloudGenerateInput): Promise<CloudGenerateResponse> {
  if (!input.image) throw new CloudApiError('Upload a product photo first.');
  if (!input.prompt.trim()) throw new CloudApiError('The generation prompt is empty.');
  if (!input.workflowText.trim()) throw new CloudApiError('The bundled LTX-2.3 workflow is missing.');

  const form = new FormData();
  form.append('image', input.image, input.image.name || 'product.png');
  form.append('workflow', input.workflowText);
  form.append('prompt', input.prompt);
  form.append('negative', input.negative);
  form.append('idempotencyKey', input.idempotencyKey);
  if (Number.isSafeInteger(input.seed)) form.append('seed', String(input.seed));

  return requestJson<CloudGenerateResponse>('/api/comfy/generate', {
    method: 'POST',
    body: form,
    signal: input.signal,
  });
}

export async function getCloudJob(jobId: string, signal?: AbortSignal): Promise<CloudJob> {
  const data = await requestJson<{ job: CloudJob }>(
    `/api/comfy/jobs/${encodeURIComponent(jobId)}`,
    { signal },
  );
  return data.job;
}

export interface CloudVideo {
  blob: Blob;
  filename: string;
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain ? plain[1] : null;
}

export async function downloadCloudVideo(jobId: string, signal?: AbortSignal): Promise<CloudVideo> {
  let response: Response;
  try {
    response = await fetch(`/api/comfy/jobs/${encodeURIComponent(jobId)}/video`, {
      signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    throw new CloudApiError(
      `Downloading the generated clip failed: ${
        error instanceof Error ? error.message : 'network error'
      }.`,
      { code: 'download_unreachable' },
    );
  }
  if (!response.ok) throw await errorFromResponse(response);

  const blob = await response.blob();
  if (!blob.size) throw new CloudApiError('Comfy Cloud returned an empty video file.');
  const filename =
    filenameFromDisposition(response.headers.get('content-disposition')) ||
    `comfy-cloud-${jobId.slice(0, 8)}.mp4`;
  const looksLikeVideo =
    blob.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(filename);
  if (!looksLikeVideo) {
    throw new CloudApiError(
      `Comfy Cloud returned "${blob.type || 'unknown content'}" instead of a video file.`,
    );
  }
  return { blob, filename };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Generation cancelled.', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Generation cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface WaitForCloudVideoOptions {
  signal?: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
  onJob: (job: CloudJob, elapsedMs: number) => void;
}

export async function waitForCloudVideo(
  jobId: string,
  options: WaitForCloudVideoOptions,
): Promise<CloudJob> {
  const pollMs = options.pollMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const started = Date.now();

  for (;;) {
    if (options.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    const job = await getCloudJob(jobId, options.signal);
    options.onJob(job, Date.now() - started);

    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'canceled' || job.status === 'expired') {
      const detail = job.error?.message ? ` ${job.error.message}` : '';
      throw new CloudApiError(`Comfy Cloud job ${job.status}.${detail}`, {
        code: `job_${job.status}`,
      });
    }
    if (Date.now() - started > timeoutMs) {
      throw new CloudApiError(
        `The Comfy Cloud job is still ${job.status} after ${Math.round(
          timeoutMs / 60000,
        )} minutes. The job may still finish; check your Comfy Cloud workspace.`,
        { code: 'job_timeout' },
      );
    }
    await sleep(pollMs, options.signal);
  }
}
