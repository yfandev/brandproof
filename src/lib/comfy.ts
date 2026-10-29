export type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

export type Workflow = Record<string, WorkflowNode>;

export class ComfyError extends Error {}

export interface ComfyConnection {
  ok: boolean;
  message: string;
  version: string | null;
  devices: string[];
}

export interface ComfyVideoRef {
  filename: string;
  subfolder: string;
  type: string;
}

export type GenerationEvent =
  | { type: 'log'; message: string; tone?: 'info' | 'warn' | 'error' | 'success' }
  | { type: 'queued'; promptId: string }
  | { type: 'tick'; elapsedMs: number; state: string; queuePosition: number | null }
  | { type: 'video'; blob: Blob; filename: string; promptId: string };

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mkv', 'mov'];
const ANIMATED_EXTENSIONS = ['gif', 'webp'];
const POLL_INTERVAL_MS = 2000;
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) throw new ComfyError('Enter the URL of your ComfyUI server, for example http://127.0.0.1:8188.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ComfyError('That ComfyUI URL is not valid. Use a full origin such as http://127.0.0.1:8188.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ComfyError('ComfyUI must be reached over http:// or https://.');
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

function friendlyNetworkError(baseUrl: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not reach ComfyUI at ${baseUrl} (${detail}). Confirm the server is running, restart it with --enable-cors-header so this page can call it, and check that no firewall blocks the port.`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Response> {
  if (external?.aborted) throw new ComfyError('Generation cancelled.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (external?.aborted) throw new ComfyError('Generation cancelled.');
    if (controller.signal.aborted) {
      throw new ComfyError(
        `ComfyUI did not respond within ${Math.round(timeoutMs / 1000)}s at ${url}. It may be busy or unreachable.`,
      );
    }
    throw new ComfyError(friendlyNetworkError(new URL(url).origin, error));
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 800);
  } catch {
    return '';
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<unknown> {
  const response = await fetchWithTimeout(url, init, timeoutMs, external);
  if (!response.ok) {
    const body = await readBody(response);
    throw new ComfyError(
      `ComfyUI returned HTTP ${response.status} for ${new URL(url).pathname}${body ? `: ${body}` : ''}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ComfyError(`ComfyUI returned a response that was not JSON at ${new URL(url).pathname}.`);
  }
}

export async function testComfyConnection(baseUrl: string, timeoutMs = 8000): Promise<ComfyConnection> {
  let base: string;
  try {
    base = normalizeBaseUrl(baseUrl);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid ComfyUI URL.',
      version: null,
      devices: [],
    };
  }

  try {
    const data = (await fetchJson(`${base}/system_stats`, { method: 'GET' }, timeoutMs)) as {
      system?: { comfyui_version?: string; python_version?: string };
      devices?: Array<{ name?: string; type?: string; vram_total?: number }>;
    };
    const version = data.system?.comfyui_version ?? null;
    const devices = (data.devices ?? [])
      .filter((device) => Boolean(device.name))
      .map((device) => {
        const vram = device.vram_total
          ? ` · ${(device.vram_total / 1024 ** 3).toFixed(1)} GB VRAM`
          : '';
        return `${device.name}${device.type ? ` (${device.type})` : ''}${vram}`;
      });
    return {
      ok: true,
      message: `Connected to ComfyUI${version ? ` ${version}` : ''}.`,
      version,
      devices,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed.';
    return {
      ok: false,
      message: message.includes('404')
        ? `${message} The server responded but does not look like a ComfyUI instance. Check the URL.`
        : message,
      version: null,
      devices: [],
    };
  }
}

export async function uploadReferenceImage(
  baseUrl: string,
  file: Blob,
  filename: string,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append('image', file, filename);
  form.append('overwrite', 'true');

  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(baseUrl)}/upload/image`,
    { method: 'POST', body: form },
    60000,
    signal,
  );
  if (!response.ok) {
    throw new ComfyError(`Uploading the product photo failed (HTTP ${response.status}). ${await readBody(response)}`);
  }
  const data = (await response.json()) as { name?: string; subfolder?: string };
  if (!data.name) throw new ComfyError('ComfyUI accepted the upload but did not return a filename.');
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export function parseWorkflow(text: string): Workflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ComfyError(
      `The workflow JSON could not be parsed: ${error instanceof Error ? error.message : 'invalid JSON'}.`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ComfyError('The workflow must be a JSON object in ComfyUI API format.');
  }
  if (Array.isArray((parsed as { nodes?: unknown }).nodes)) {
    throw new ComfyError(
      'That is a UI-format workflow (it has a "nodes" array). In ComfyUI use Workflow → Export (API) and paste the API-format JSON instead.',
    );
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) throw new ComfyError('The workflow JSON is empty.');
  const workflow: Workflow = {};
  for (const [id, node] of entries) {
    if (!node || typeof node !== 'object') {
      throw new ComfyError(`Workflow node ${id} is not an object.`);
    }
    const { class_type: classType, inputs } = node as { class_type?: unknown; inputs?: unknown };
    if (typeof classType !== 'string' || !classType) {
      throw new ComfyError(`Workflow node ${id} is missing "class_type". Is this API-format JSON?`);
    }
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
      throw new ComfyError(`Workflow node ${id} is missing an "inputs" object.`);
    }
    workflow[id] = {
      class_type: classType,
      inputs: { ...(inputs as Record<string, unknown>) },
      ...(node as { _meta?: { title?: string } })._meta
        ? { _meta: (node as { _meta?: { title?: string } })._meta }
        : {},
    };
  }
  return workflow;
}

export interface BindOptions {
  imageName: string;
  positive: string;
  negative: string;
  seed: number;
  width: number;
  height: number;
  frames: number;
  filenamePrefix: string;
}

export interface BindResult {
  workflow: Workflow;
  touched: string[];
  warnings: string[];
}

function nodeLabel(id: string, node: WorkflowNode): string {
  return node._meta?.title ? `${node._meta.title} (node ${id})` : `node ${id}`;
}

export function bindWorkflow(source: Workflow, options: BindOptions): BindResult {
  const workflow: Workflow = JSON.parse(JSON.stringify(source)) as Workflow;
  const touched: string[] = [];
  const warnings: string[] = [];

  const entries = Object.entries(workflow);
  const textNodes = entries.filter(([, node]) => typeof node.inputs.text === 'string');
  if (textNodes.length === 0) {
    throw new ComfyError(
      'This workflow has no text prompt node (CLIPTextEncode with a "text" input), so the generation prompt could not be applied.',
    );
  }

  const negativeNodes = textNodes.filter(([, node]) => /neg/i.test(node._meta?.title ?? ''));
  const positiveNodes = textNodes.filter(([id]) => !negativeNodes.some(([negativeId]) => negativeId === id));
  const positiveTargets = positiveNodes.length > 0 ? positiveNodes : textNodes;

  for (const [id, node] of positiveTargets) {
    node.inputs.text = options.positive;
    touched.push(`positive prompt → ${nodeLabel(id, node)}`);
  }
  if (negativeNodes.length === 0) {
    warnings.push(
      'No negative-prompt node was detected in this workflow, so the negative prompt was not applied.',
    );
  } else {
    for (const [id, node] of negativeNodes) {
      node.inputs.text = options.negative;
      touched.push(`negative prompt → ${nodeLabel(id, node)}`);
    }
  }

  const imageNodes = entries.filter(
    ([, node]) => node.class_type === 'LoadImage' || (typeof node.inputs.image === 'string' && 'upload' in node.inputs),
  );
  if (imageNodes.length === 0) {
    throw new ComfyError(
      'This workflow has no LoadImage node, so it cannot use your product photo. Add a LoadImage node or reset the bundled Wan 2.2 template.',
    );
  }
  for (const [id, node] of imageNodes) {
    node.inputs.image = options.imageName;
    touched.push(`product photo → ${nodeLabel(id, node)}`);
  }

  const dimensionClasses = new Set([
    'Wan22ImageToVideoLatent',
    'WanImageToVideo',
    'WanFirstLastFrameToVideo',
    'EmptyLTXVLatentVideo',
    'EmptyHunyuanLatentVideo',
    'EmptyMochiLatentVideo',
    'EmptyCosmosLatentVideo',
  ]);
  for (const [id, node] of entries) {
    if (!dimensionClasses.has(node.class_type)) continue;
    if (typeof node.inputs.width === 'number') node.inputs.width = options.width;
    if (typeof node.inputs.height === 'number') node.inputs.height = options.height;
    if (typeof node.inputs.length === 'number') node.inputs.length = options.frames;
    touched.push(`resolution ${options.width}×${options.height}, ${options.frames} frames → ${nodeLabel(id, node)}`);
  }

  for (const [id, node] of entries) {
    if (typeof node.inputs.seed === 'number') {
      node.inputs.seed = options.seed;
      touched.push(`seed → ${nodeLabel(id, node)}`);
    }
    if (typeof node.inputs.noise_seed === 'number') {
      node.inputs.noise_seed = options.seed;
      touched.push(`noise seed → ${nodeLabel(id, node)}`);
    }
  }

  const outputNodes = entries.filter(([, node]) =>
    ['SaveVideo', 'VHS_VideoCombine', 'SaveAnimatedWEBP', 'SaveWEBM'].includes(node.class_type),
  );
  if (outputNodes.length === 0) {
    warnings.push(
      'No SaveVideo (or compatible) node was found. ComfyUI may return an image preview instead of a video, which BrandProof cannot verify.',
    );
  }
  for (const [id, node] of outputNodes) {
    if (typeof node.inputs.filename_prefix === 'string') {
      node.inputs.filename_prefix = options.filenamePrefix;
      touched.push(`output prefix → ${nodeLabel(id, node)}`);
    }
  }

  return { workflow, touched, warnings };
}

interface NodeErrorShape {
  class_type?: string;
  errors?: Array<{ message?: string; details?: string }>;
}

function formatNodeErrors(nodeErrors: unknown): string {
  if (!nodeErrors || typeof nodeErrors !== 'object') return '';
  const parts: string[] = [];
  for (const [id, value] of Object.entries(nodeErrors as Record<string, NodeErrorShape>)) {
    const errors = value?.errors ?? [];
    for (const error of errors) {
      parts.push(`node ${id}${value.class_type ? ` (${value.class_type})` : ''}: ${error.message ?? 'invalid input'}${error.details ? ` — ${error.details}` : ''}`);
    }
  }
  return parts.slice(0, 4).join('; ');
}

export async function queuePrompt(
  baseUrl: string,
  workflow: Workflow,
  clientId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(baseUrl)}/prompt`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    },
    30000,
    signal,
  );

  const body = await readBody(response);
  let data: { prompt_id?: string; error?: { message?: string; details?: string }; node_errors?: unknown } = {};
  try {
    data = body ? (JSON.parse(body) as typeof data) : {};
  } catch {
    // handled below
  }

  if (!response.ok) {
    const nodeMessage = formatNodeErrors(data.node_errors);
    const baseMessage = data.error?.message ?? `HTTP ${response.status}`;
    throw new ComfyError(
      `ComfyUI rejected the workflow: ${baseMessage}${nodeMessage ? ` — ${nodeMessage}` : ''}. Check that the model files exist in ComfyUI/models and that the node versions match.`,
    );
  }
  if (!data.prompt_id) {
    const nodeMessage = formatNodeErrors(data.node_errors);
    throw new ComfyError(
      `ComfyUI did not return a prompt id${nodeMessage ? `: ${nodeMessage}` : '.'} It may have rejected the workflow silently.`,
    );
  }
  return data.prompt_id;
}

function filenameExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

export function extractVideoRef(outputs: unknown): { video: ComfyVideoRef | null; animated: ComfyVideoRef | null } {
  let video: ComfyVideoRef | null = null;
  let animated: ComfyVideoRef | null = null;
  if (!outputs || typeof outputs !== 'object') return { video, animated };

  for (const nodeOutput of Object.values(outputs as Record<string, unknown>)) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue;
    for (const value of Object.values(nodeOutput as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as { filename?: unknown; subfolder?: unknown; type?: unknown };
        if (typeof candidate.filename !== 'string') continue;
        const ref: ComfyVideoRef = {
          filename: candidate.filename,
          subfolder: typeof candidate.subfolder === 'string' ? candidate.subfolder : '',
          type: typeof candidate.type === 'string' ? candidate.type : 'output',
        };
        const extension = filenameExtension(ref.filename);
        if (!video && VIDEO_EXTENSIONS.includes(extension)) video = ref;
        else if (!animated && ANIMATED_EXTENSIONS.includes(extension)) animated = ref;
      }
    }
  }
  return { video, animated };
}

function extractExecutionError(entry: unknown): string {
  const status = (entry as { status?: { messages?: unknown; status_str?: string } })?.status;
  if (!status) return 'ComfyUI reported an execution error.';
  if (Array.isArray(status.messages)) {
    for (const message of status.messages) {
      if (!Array.isArray(message)) continue;
      const [kind, payload] = message as [string, { exception_message?: string; node_id?: string; node_type?: string }];
      if (kind === 'execution_error' && payload) {
        return `ComfyUI execution failed at node ${payload.node_id ?? '?'}${payload.node_type ? ` (${payload.node_type})` : ''}: ${payload.exception_message?.trim() || 'unknown error'}`;
      }
    }
  }
  return 'ComfyUI reported an execution error. Check the ComfyUI console for details.';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ComfyError('Generation cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ComfyError('Generation cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForComfyVideo(
  baseUrl: string,
  promptId: string,
  options: {
    signal?: AbortSignal;
    pollMs?: number;
    timeoutMs?: number;
    onTick?: (info: { elapsedMs: number; state: string; queuePosition: number | null }) => void;
  } = {},
): Promise<ComfyVideoRef> {
  const base = normalizeBaseUrl(baseUrl);
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? GENERATION_TIMEOUT_MS;
  const started = Date.now();

  for (;;) {
    if (options.signal?.aborted) throw new ComfyError('Generation cancelled.');
    if (Date.now() - started > timeoutMs) {
      throw new ComfyError(
        `ComfyUI did not finish within ${Math.round(timeoutMs / 60000)} minutes. The clip may still be queued — check the ComfyUI queue.`,
      );
    }

    const history = (await fetchJson(`${base}/history/${promptId}`, { method: 'GET' }, 20000, options.signal)) as Record<
      string,
      { status?: { status_str?: string; completed?: boolean; messages?: unknown }; outputs?: unknown }
    >;

    const entry = history?.[promptId];
    if (entry) {
      if (entry.status?.status_str === 'error') {
        throw new ComfyError(extractExecutionError(entry));
      }
      const { video, animated } = extractVideoRef(entry.outputs);
      if (video) return video;
      if (entry.status?.completed || entry.status?.status_str === 'success') {
        if (animated) {
          throw new ComfyError(
            `ComfyUI returned an animated image (${animated.filename}) instead of a video. Add a SaveVideo node set to mp4/h264 to your workflow — BrandProof can only verify real video files.`,
          );
        }
        throw new ComfyError(
          'ComfyUI finished but returned no video file. Add a SaveVideo node (mp4) and re-export the workflow in API format.',
        );
      }
    }

    let state = 'queued';
    let queuePosition: number | null = null;
    try {
      const queue = (await fetchJson(`${base}/queue`, { method: 'GET' }, 10000, options.signal)) as {
        queue_running?: unknown[][];
        queue_pending?: unknown[][];
      };
      const running = (queue.queue_running ?? []).some((item) => item?.[1] === promptId);
      const pendingIndex = (queue.queue_pending ?? []).findIndex((item) => item?.[1] === promptId);
      if (running) state = 'generating';
      else if (pendingIndex >= 0) {
        state = 'queued';
        queuePosition = pendingIndex + 1;
      } else {
        state = 'finalising';
      }
    } catch (error) {
      if (error instanceof ComfyError && error.message.includes('cancelled')) throw error;
      // Queue introspection is a nicety; history polling is authoritative.
    }

    options.onTick?.({ elapsedMs: Date.now() - started, state, queuePosition });
    await delay(pollMs, options.signal);
  }
}

export function comfyOutputUrl(baseUrl: string, ref: ComfyVideoRef): string {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder,
    type: ref.type,
  });
  return `${normalizeBaseUrl(baseUrl)}/view?${params.toString()}`;
}

export async function fetchComfyOutput(
  baseUrl: string,
  ref: ComfyVideoRef,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetchWithTimeout(comfyOutputUrl(baseUrl, ref), { method: 'GET' }, 180000, signal);
  if (!response.ok) {
    throw new ComfyError(`Downloading the generated clip failed (HTTP ${response.status}).`);
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new ComfyError('ComfyUI returned an empty video file.');
  if (blob.type.startsWith('image/')) {
    throw new ComfyError(
      'ComfyUI returned an image, not a video. Use a workflow with a SaveVideo node (mp4/h264) and generate again.',
    );
  }
  return blob;
}

export function comfyDimensionsFor(width: number, height: number): { width: number; height: number } {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  if (aspect > 1.2) return { width: 832, height: 480 };
  if (aspect < 0.83) return { width: 480, height: 832 };
  return { width: 640, height: 640 };
}

export interface GenerateOptions {
  baseUrl: string;
  workflow: Workflow;
  imageFile: Blob;
  imageFilename: string;
  positive: string;
  negative: string;
  seed: number;
  width: number;
  height: number;
  frames: number;
  onEvent: (event: GenerationEvent) => void;
  signal: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
}

export async function generateVideo(
  options: GenerateOptions,
): Promise<{ blob: Blob; filename: string; promptId: string }> {
  const base = normalizeBaseUrl(options.baseUrl);
  const emit = options.onEvent;

  emit({ type: 'log', message: `Contacting ComfyUI at ${base}`, tone: 'info' });
  const connection = await testComfyConnection(base, 8000);
  if (!connection.ok) throw new ComfyError(connection.message);
  emit({
    type: 'log',
    message: `Connected${connection.version ? ` to ComfyUI ${connection.version}` : ''}${connection.devices.length > 0 ? ` · ${connection.devices[0]}` : ''}`,
    tone: 'success',
  });

  const imageName = await uploadReferenceImage(base, options.imageFile, options.imageFilename, options.signal);
  emit({ type: 'log', message: `Uploaded reference photo as ${imageName}`, tone: 'success' });

  const bound = bindWorkflow(options.workflow, {
    imageName,
    positive: options.positive,
    negative: options.negative,
    seed: options.seed,
    width: options.width,
    height: options.height,
    frames: options.frames,
    filenamePrefix: `brandproof/clip-${Date.now()}`,
  });
  emit({
    type: 'log',
    message: `Workflow prepared · ${bound.touched.length} values injected`,
    tone: 'info',
  });
  for (const warning of bound.warnings) emit({ type: 'log', message: warning, tone: 'warn' });

  emit({
    type: 'log',
    message: `Submitting ${options.width}×${options.height}, ${options.frames} frames, seed ${options.seed}. A 5B model on a local GPU usually takes 1–8 minutes.`,
    tone: 'info',
  });

  const promptId = await queuePrompt(base, bound.workflow, crypto.randomUUID(), options.signal);
  emit({ type: 'queued', promptId });
  emit({ type: 'log', message: `ComfyUI accepted the job (prompt ${promptId.slice(0, 8)}…)`, tone: 'success' });

  const ref = await waitForComfyVideo(base, promptId, {
    signal: options.signal,
    pollMs: options.pollMs,
    timeoutMs: options.timeoutMs,
    onTick: (tick) => emit({ type: 'tick', ...tick }),
  });
  emit({ type: 'log', message: `ComfyUI produced ${ref.filename} · downloading`, tone: 'success' });

  const blob = await fetchComfyOutput(base, ref, options.signal);
  emit({ type: 'video', blob, filename: ref.filename, promptId });
  return { blob, filename: ref.filename, promptId };
}
