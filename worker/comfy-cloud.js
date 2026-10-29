/**
 * Server-side Comfy Cloud client for BrandProof.
 *
 * Runs in the Cloudflare Worker in production and in Vite's dev middleware
 * locally. The Comfy API key never reaches the browser.
 *
 * Comfy API v2:
 *   POST /api/v2/assets          upload the product photo
 *   POST /api/v2/jobs            submit an API-format workflow
 *   GET  /api/v2/jobs/{id}       poll status + outputs
 *   GET  /api/v2/assets/{id}/content  download the returned MP4
 *
 * BrandProof bundles the LTX-2.3 workflow, converts it to an API-format graph
 * in the browser, and injects the photo as a core/ASSET reference plus the
 * prepared prompt. The Worker validates every graph again.
 */

export const COMFY_BASE = 'https://cloud.comfy.org';
export const MAX_WORKFLOW_BYTES = 2_000_000;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const VIDEO_NODE_CLASSES = new Set(['SaveVideo', 'SaveWEBM', 'VHS_VideoCombine']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,99}$/;

export class ComfyCloudError extends Error {
  constructor(message, { status = 502, code = 'comfy_error', details = null } = {}) {
    super(message);
    this.name = 'ComfyCloudError';
    this.status = status;
    this.code = code;
    this.details = details;
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
  const status = error instanceof ComfyCloudError ? error.status : 500;
  const code = error instanceof ComfyCloudError ? error.code : 'internal_error';
  const message =
    error instanceof ComfyCloudError
      ? error.message
      : 'BrandProof could not complete the Comfy Cloud request.';
  return json(
    {
      error: {
        code,
        message,
        ...(error instanceof ComfyCloudError && error.details ? { details: error.details } : {}),
      },
    },
    status,
  );
}

function normalizeNode(node, id) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new ComfyCloudError(`Workflow node ${id} is not an object.`, {
      status: 422,
      code: 'invalid_workflow',
    });
  }
  if (typeof node.class_type !== 'string' || !node.class_type) {
    throw new ComfyCloudError(`Workflow node ${id} is missing "class_type".`, {
      status: 422,
      code: 'invalid_workflow',
    });
  }
  if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
    throw new ComfyCloudError(`Workflow node ${id} is missing an "inputs" object.`, {
      status: 422,
      code: 'invalid_workflow',
    });
  }
  return {
    class_type: node.class_type,
    inputs: { ...node.inputs },
    ...(node._meta && typeof node._meta === 'object' ? { _meta: { ...node._meta } } : {}),
  };
}

export function parseApiWorkflow(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ComfyCloudError('Load an API-format workflow JSON before generating.', {
      status: 422,
      code: 'workflow_required',
    });
  }
  if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_BYTES) {
    throw new ComfyCloudError('The workflow JSON is larger than 2 MB.', {
      status: 413,
      code: 'workflow_too_large',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ComfyCloudError(
      `The workflow JSON could not be parsed: ${error instanceof Error ? error.message : 'invalid JSON'}.`,
      { status: 422, code: 'invalid_workflow' },
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ComfyCloudError('The workflow must be a JSON object in Comfy API format.', {
      status: 422,
      code: 'invalid_workflow',
    });
  }
  if (Array.isArray(parsed.nodes)) {
    throw new ComfyCloudError(
      'That is a UI-format workflow (it has a "nodes" array). In Comfy Cloud use Export → API format, then load that JSON.',
      { status: 422, code: 'workflow_format_ui' },
    );
  }

  const workflow = {};
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new ComfyCloudError('The workflow JSON is empty.', {
      status: 422,
      code: 'invalid_workflow',
    });
  }
  for (const [id, node] of entries) {
    workflow[id] = normalizeNode(node, id);
  }

  const nodes = Object.entries(workflow);
  const textNodes = nodes.filter(
    ([, node]) => typeof node.inputs.text === 'string' || /CLIPTextEncode/i.test(node.class_type),
  );
  if (textNodes.length === 0) {
    throw new ComfyCloudError(
      'This workflow has no text prompt input (a node with an "inputs.text" string). The BrandProof prompt cannot be applied safely.',
      { status: 422, code: 'prompt_node_missing' },
    );
  }

  const negativeNodes = textNodes.filter(([, node]) => /neg/i.test(String(node._meta?.title ?? '')));
  const positiveNodes = textNodes.filter(
    ([id]) => !negativeNodes.some(([negativeId]) => negativeId === id),
  );
  const promptNodes = positiveNodes.length > 0 ? positiveNodes : textNodes;

  const imageNodes = nodes.filter(
    ([, node]) =>
      node.class_type === 'LoadImage' ||
      (typeof node.inputs.image === 'string' && /loadimage/i.test(node.class_type)),
  );
  if (imageNodes.length === 0) {
    throw new ComfyCloudError(
      'This workflow has no LoadImage node, so it cannot use the product photo. Add a LoadImage node and export the API workflow again.',
      { status: 422, code: 'image_node_missing' },
    );
  }

  const outputNodes = nodes.filter(([, node]) => VIDEO_NODE_CLASSES.has(node.class_type));
  if (outputNodes.length === 0) {
    throw new ComfyCloudError(
      'This workflow has no SaveVideo (or compatible video output) node. BrandProof can only verify a real video file.',
      { status: 422, code: 'video_node_missing' },
    );
  }

  const warnings = [];
  if (negativeNodes.length === 0) {
    warnings.push(
      'No negative-prompt node was detected by its title. The negative prompt was not applied.',
    );
  }

  return {
    workflow,
    report: {
      nodeCount: nodes.length,
      promptNodes: promptNodes.map(([id]) => id),
      negativeNodes: negativeNodes.map(([id]) => id),
      imageNodes: imageNodes.map(([id]) => id),
      outputNodes: outputNodes.map(([id]) => id),
      warnings,
    },
  };
}

export function bindWorkflow(parsed, { asset, prompt, negative, seed }) {
  if (!asset?.id) {
    throw new ComfyCloudError('The product photo upload did not return an asset id.', {
      status: 502,
      code: 'asset_upload_failed',
    });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ComfyCloudError('The generation prompt is empty.', {
      status: 422,
      code: 'prompt_required',
    });
  }

  const workflow = JSON.parse(JSON.stringify(parsed.workflow));
  const touched = [];
  const assetRef = {
    __type: 'core/ASSET',
    info: {
      id: asset.id,
      ...(asset.hash ? { hash: asset.hash } : {}),
      ...(asset.file_path ? { file_path: asset.file_path } : {}),
    },
  };

  for (const id of parsed.report.promptNodes) {
    workflow[id].inputs.text = prompt;
    touched.push(`prompt → node ${id}`);
  }
  if (negative.trim()) {
    for (const id of parsed.report.negativeNodes) {
      workflow[id].inputs.text = negative;
      touched.push(`negative prompt → node ${id}`);
    }
  }
  for (const id of parsed.report.imageNodes) {
    workflow[id].inputs.image = assetRef;
    touched.push(`product photo → node ${id}`);
  }

  if (Number.isSafeInteger(seed) && seed >= 0) {
    for (const [id, node] of Object.entries(workflow)) {
      if (typeof node.inputs.seed === 'number') {
        node.inputs.seed = seed;
        touched.push(`seed → node ${id}`);
      }
      if (typeof node.inputs.noise_seed === 'number') {
        node.inputs.noise_seed = seed;
        touched.push(`noise seed → node ${id}`);
      }
    }
  }

  return { workflow, touched, report: parsed.report };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nodeErrorSummary(details) {
  const nodeErrors = details?.node_errors;
  if (!nodeErrors || typeof nodeErrors !== 'object') return '';
  const lines = [];
  for (const [id, node] of Object.entries(nodeErrors)) {
    if (!node || typeof node !== 'object') continue;
    const errors = Array.isArray(node.errors) ? node.errors : [];
    for (const entry of errors) {
      lines.push(
        `node ${id}${node.class_type ? ` (${node.class_type})` : ''}: ${
          entry?.message ?? entry?.type ?? 'invalid input'
        }${entry?.details ? ` — ${entry.details}` : ''}`,
      );
    }
  }
  return lines.slice(0, 4).join('; ');
}

async function cloudResponseError(response) {
  const payload = await readJson(response);
  const envelope = payload?.error ?? {};
  let message = envelope.message || `Comfy Cloud returned HTTP ${response.status}.`;
  const nodeMessage = nodeErrorSummary(envelope.details ?? payload);
  if (nodeMessage) message = `${message} — ${nodeMessage}`;

  if (response.status === 401) {
    message =
      'Comfy Cloud rejected the API key. Create a key at platform.comfy.org → API Keys and store it as COMFY_API_KEY.';
  } else if (response.status === 402) {
    message =
      'Comfy Cloud reports insufficient credits for this workspace. Check the workspace billing/credits, then try again.';
  } else if (response.status === 403) {
    message = `Comfy Cloud refused this request (403). ${message}`;
  } else if (response.status === 422 && envelope.code === 'workflow_format_ui') {
    message =
      'Comfy Cloud rejected a UI-format workflow. Export the workflow with Export → API format and load that file.';
  }

  return new ComfyCloudError(message, {
    status: response.status >= 500 ? 502 : response.status,
    code: `comfy_${envelope.code || response.status}`,
    details: envelope.details ?? null,
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ComfyCloudError(
        `Comfy Cloud did not respond within ${Math.round(timeoutMs / 1000)} seconds.`,
        { status: 504, code: 'comfy_timeout' },
      );
    }
    throw new ComfyCloudError(
      `Could not reach Comfy Cloud (${error instanceof Error ? error.message : 'network error'}).`,
      { status: 502, code: 'comfy_unreachable' },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function cloudJson(path, init, { key, fetchImpl, timeoutMs = 60000 }) {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${COMFY_BASE}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init.headers || {}),
      },
    },
    timeoutMs,
  );
  if (!response.ok) throw await cloudResponseError(response);
  const data = await readJson(response);
  if (!data || typeof data !== 'object') {
    throw new ComfyCloudError('Comfy Cloud returned an empty or non-JSON response.', {
      status: 502,
      code: 'comfy_bad_response',
    });
  }
  return data;
}

function imageExtension(file) {
  const fromName = String(file.name || '').split('.').pop()?.toLowerCase();
  if (fromName === 'png' || fromName === 'jpg' || fromName === 'jpeg' || fromName === 'webp' || fromName === 'avif') {
    return fromName === 'jpeg' ? 'jpg' : fromName;
  }
  if (file.type === 'image/jpeg') return 'jpg';
  if (file.type === 'image/webp') return 'webp';
  if (file.type === 'image/avif') return 'avif';
  return 'png';
}

async function uploadAsset(image, { key, fetchImpl, idempotencyKey }) {
  if (!image || typeof image === 'string' || typeof image.arrayBuffer !== 'function') {
    throw new ComfyCloudError('Attach the product photo as an image file.', {
      status: 422,
      code: 'image_required',
    });
  }
  if (!image.size) {
    throw new ComfyCloudError('The product photo is empty.', { status: 422, code: 'image_empty' });
  }
  if (image.size > MAX_IMAGE_BYTES) {
    throw new ComfyCloudError('The product photo is larger than 25 MB.', {
      status: 413,
      code: 'image_too_large',
    });
  }

  const type = IMAGE_TYPES.has(image.type) ? image.type : `image/${imageExtension(image)}`;
  if (!IMAGE_TYPES.has(type)) {
    throw new ComfyCloudError('Use a PNG, JPEG, WebP or AVIF product photo.', {
      status: 415,
      code: 'image_type_unsupported',
    });
  }

  const filePath = `brandproof-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${imageExtension(image)}`;
  // Comfy Cloud streams the multipart body and stops reading metadata after
  // the file part. Both fields must precede the file bytes.
  const form = new FormData();
  form.append('content_type', type);
  form.append('file_path', filePath);
  form.append('file', image, filePath);

  const data = await cloudJson('/api/v2/assets', {
    method: 'POST',
    headers: {
      'Idempotency-Key': `asset-${idempotencyKey}`,
    },
    body: form,
  }, { key, fetchImpl, timeoutMs: 120000 });

  if (!data.id || typeof data.id !== 'string') {
    throw new ComfyCloudError('Comfy Cloud accepted the photo but returned no asset id.', {
      status: 502,
      code: 'asset_upload_failed',
    });
  }
  return {
    id: data.id,
    hash: typeof data.hash === 'string' ? data.hash : undefined,
    file_path: typeof data.file_path === 'string' ? data.file_path : filePath,
    name: filePath,
  };
}

async function submitJob(workflow, { key, fetchImpl, idempotencyKey }) {
  const data = await cloudJson('/api/v2/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ workflow }),
  }, { key, fetchImpl, timeoutMs: 60000 });

  if (!data.id || typeof data.id !== 'string') {
    throw new ComfyCloudError('Comfy Cloud accepted the workflow but returned no job id.', {
      status: 502,
      code: 'job_submit_failed',
    });
  }
  return data;
}

function jobView(job) {
  if (!job || typeof job !== 'object') {
    throw new ComfyCloudError('Comfy Cloud returned an invalid job object.', {
      status: 502,
      code: 'comfy_bad_response',
    });
  }
  const outputs = Array.isArray(job.outputs)
    ? job.outputs
        .filter((output) => output && typeof output === 'object' && typeof output.id === 'string')
        .map((output) => ({
          id: output.id,
          name: typeof output.name === 'string' ? output.name : 'output',
          type: typeof output.type === 'string' ? output.type : 'file',
          contentType: typeof output.content_type === 'string' ? output.content_type : '',
          sizeBytes: typeof output.size_bytes === 'number' ? output.size_bytes : null,
        }))
    : [];

  return {
    id: job.id,
    status: job.status,
    queuePosition: typeof job.queue_position === 'number' ? job.queue_position : null,
    progress:
      job.progress && typeof job.progress === 'object'
        ? {
            value: typeof job.progress.value === 'number' ? job.progress.value : null,
            nodesDone: typeof job.progress.nodes_done === 'number' ? job.progress.nodes_done : null,
            nodesTotal: typeof job.progress.nodes_total === 'number' ? job.progress.nodes_total : null,
            step: typeof job.progress.step === 'number' ? job.progress.step : null,
            steps: typeof job.progress.steps === 'number' ? job.progress.steps : null,
            message: typeof job.progress.message === 'string' ? job.progress.message : null,
          }
        : null,
    outputs,
    error: job.error
      ? {
          code: String(job.error.code || 'execution_error'),
          message: String(job.error.message || 'Comfy Cloud job failed.'),
          nodeId: job.error.node_id ? String(job.error.node_id) : null,
          classType: job.error.class_type ? String(job.error.class_type) : null,
        }
      : null,
  };
}

async function fetchJob(jobId, { key, fetchImpl }) {
  return jobView(
    await cloudJson(`/api/v2/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, {
      key,
      fetchImpl,
      timeoutMs: 30000,
    }),
  );
}

export function selectVideoOutput(job) {
  const outputs = Array.isArray(job.outputs) ? job.outputs : [];
  const video = outputs.find(
    (output) =>
      output.type === 'video' ||
      String(output.contentType || '').startsWith('video/') ||
      /\.(mp4|webm|mov|mkv)$/i.test(String(output.name || '')),
  );
  if (video) return video;

  const animated = outputs.find(
    (output) =>
      output.type === 'image' &&
      (/gif|webp/i.test(String(output.contentType || '')) ||
        /\.(gif|webp)$/i.test(String(output.name || ''))),
  );
  if (animated) {
    throw new ComfyCloudError(
      `Comfy Cloud returned an animated image (${animated.name}), not a video. Add a SaveVideo node with MP4 output to the workflow.`,
      { status: 422, code: 'no_video_output' },
    );
  }
  throw new ComfyCloudError(
    'Comfy Cloud finished but returned no video output. Check that the workflow has a SaveVideo (MP4) node.',
    { status: 422, code: 'no_video_output' },
  );
}

async function fetchAssetContent(assetId, { key, fetchImpl }) {
  const endpoint = `${COMFY_BASE}/api/v2/assets/${encodeURIComponent(assetId)}/content`;
  let response = await fetchWithTimeout(
    fetchImpl,
    endpoint,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'manual',
    },
    180000,
  );

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    if (!location) {
      throw new ComfyCloudError('Comfy Cloud returned a redirect without a download URL.', {
        status: 502,
        code: 'asset_download_failed',
      });
    }
    // Signed storage URLs carry their own authorization. Never forward the key.
    response = await fetchWithTimeout(
      fetchImpl,
      new URL(location, COMFY_BASE).toString(),
      { method: 'GET', redirect: 'follow' },
      180000,
    );
  }

  if (!response.ok) {
    throw new ComfyCloudError(
      `Downloading the generated MP4 failed (HTTP ${response.status}).`,
      { status: 502, code: 'asset_download_failed' },
    );
  }
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.startsWith('text/html') || contentType.includes('application/json')) {
    throw new ComfyCloudError(
      'Comfy Cloud returned a document instead of video bytes. The output asset may have expired.',
      { status: 502, code: 'asset_download_failed' },
    );
  }
  return response;
}

function safeFilename(name) {
  const cleaned = String(name || 'brandproof-comfy.mp4')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .slice(-120);
  return cleaned.toLowerCase().endsWith('.mp4') || cleaned.toLowerCase().endsWith('.webm')
    ? cleaned
    : `${cleaned || 'brandproof-comfy'}.mp4`;
}

function requestKey(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{8,128}$/.test(trimmed) ? trimmed : crypto.randomUUID();
}

function collectStringFields(source, pattern, depth = 0) {
  const found = [];
  if (!source || typeof source !== 'object' || depth > 5) return found;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && pattern.test(key) && value.trim()) found.push(value.trim());
    else if (value && typeof value === 'object') found.push(...collectStringFields(value, pattern, depth + 1));
  }
  return found;
}

function collectNumberFields(source, pattern, depth = 0) {
  const found = [];
  if (!source || typeof source !== 'object' || depth > 5) return found;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value) && pattern.test(key)) {
      found.push({ key, value });
    } else if (value && typeof value === 'object') {
      found.push(...collectNumberFields(value, pattern, depth + 1));
    }
  }
  return found;
}

/** Cents in Comfy's billing payload despite the `_micros` suffix. */
function centsToUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) / 100 : null;
}

/**
 * Reports which Comfy Cloud workspace the server key belongs to, using the
 * documented account and billing endpoints. A key is scoped to the workspace
 * that created it, so its credit balance is that workspace's balance.
 */
async function accountSummary({ key, fetchImpl }) {
  const warnings = [];
  let user = null;
  let billing = null;

  try {
    user = await cloudJson('/api/user', { method: 'GET' }, { key, fetchImpl, timeoutMs: 20000 });
  } catch (error) {
    warnings.push(
      `The Comfy Cloud account endpoint did not answer: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  try {
    billing = await cloudJson(
      '/api/billing/usage/timeseries?granularity=month&months=1',
      { method: 'GET' },
      { key, fetchImpl, timeoutMs: 20000 },
    );
  } catch (error) {
    warnings.push(
      `The Comfy Cloud billing endpoint did not answer: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  const workspaceNames = user ? collectStringFields(user, /workspace|organi[sz]ation|team|tenant/i) : [];
  const emails = user ? collectStringFields(user, /email/i) : [];
  const balance = billing?.summary?.balance ?? null;
  const spend = typeof billing?.summary?.spend_micros === 'number' ? billing.summary.spend_micros / 1_000_000 : null;

  return {
    endpoint: COMFY_BASE,
    email: emails[0] ?? null,
    workspaceName: workspaceNames[0] ?? null,
    balanceUsd: centsToUsd(balance?.amount_micros),
    prepaidUsd: centsToUsd(balance?.prepaid_balance_micros),
    cloudCreditUsd: centsToUsd(balance?.cloud_credit_balance_micros),
    currency: typeof balance?.currency === 'string' ? balance.currency : null,
    spendUsd: spend,
    accountCredits: user ? collectNumberFields(user, /credit|balance|remaining/i).slice(0, 6) : [],
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

export async function handleComfyRequest(request, env = {}, options = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  const key = typeof env.COMFY_API_KEY === 'string' ? env.COMFY_API_KEY.trim() : '';
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);

  try {
    if (path === '/api/comfy/status') {
      if (method !== 'GET') {
        throw new ComfyCloudError('Use GET for the Comfy status endpoint.', {
          status: 405,
          code: 'method_not_allowed',
        });
      }
      return json({
        configured: Boolean(key),
        provider: 'Comfy Cloud',
        api: 'v2',
        workflowRequired: true,
      });
    }

    if (path === '/api/comfy/account') {
      if (method !== 'GET') {
        throw new ComfyCloudError('Use GET for the Comfy account endpoint.', {
          status: 405,
          code: 'method_not_allowed',
        });
      }
      if (!key) {
        throw new ComfyCloudError(
          'Comfy Cloud is not configured. Add COMFY_API_KEY as a project secret, then redeploy.',
          { status: 503, code: 'comfy_not_configured' },
        );
      }
      return json(await accountSummary({ key, fetchImpl }));
    }

    if (path === '/api/comfy/generate') {
      if (method !== 'POST') {
        throw new ComfyCloudError('Use POST to generate a clip.', {
          status: 405,
          code: 'method_not_allowed',
        });
      }
      if (!key) {
        throw new ComfyCloudError(
          'Comfy Cloud is not configured. Add COMFY_API_KEY as a project secret, then redeploy.',
          { status: 503, code: 'comfy_not_configured' },
        );
      }

      let form;
      try {
        form = await request.formData();
      } catch {
        throw new ComfyCloudError('The generation form was not readable multipart data.', {
          status: 400,
          code: 'invalid_form',
        });
      }

      const image = form.get('image');
      const workflowText = form.get('workflow');
      const prompt = String(form.get('prompt') ?? '').trim();
      const negative = String(form.get('negative') ?? '').trim();
      const seedRaw = String(form.get('seed') ?? '').trim();
      const seed = /^\d+$/.test(seedRaw) ? Number(seedRaw) : undefined;
      const idempotencyKey = requestKey(
        String(form.get('idempotencyKey') ?? request.headers.get('Idempotency-Key') ?? ''),
      );

      const parsed = parseApiWorkflow(typeof workflowText === 'string' ? workflowText : '');
      const asset = await uploadAsset(image, { key, fetchImpl, idempotencyKey });
      const bound = bindWorkflow(parsed, { asset, prompt, negative, seed });
      const job = await submitJob(bound.workflow, { key, fetchImpl, idempotencyKey });

      return json(
        {
          jobId: job.id,
          status: job.status,
          job: jobView(job),
          asset: { name: asset.name },
          bindings: bound.touched,
          workflow: bound.report,
        },
        201,
      );
    }

    const jobMatch = /^\/api\/comfy\/jobs\/([^/]+)(\/video)?$/.exec(path);
    if (jobMatch) {
      if (method !== 'GET') {
        throw new ComfyCloudError('Use GET to read a Comfy Cloud job.', {
          status: 405,
          code: 'method_not_allowed',
        });
      }
      if (!key) {
        throw new ComfyCloudError(
          'Comfy Cloud is not configured. Add COMFY_API_KEY as a project secret, then redeploy.',
          { status: 503, code: 'comfy_not_configured' },
        );
      }
      const jobId = jobMatch[1];
      if (!JOB_ID_PATTERN.test(jobId)) {
        throw new ComfyCloudError('That Comfy Cloud job id is not valid.', {
          status: 400,
          code: 'invalid_job_id',
        });
      }

      if (!jobMatch[2]) {
        return json({ job: await fetchJob(jobId, { key, fetchImpl }) });
      }

      const job = await fetchJob(jobId, { key, fetchImpl });
      if (job.status !== 'succeeded') {
        throw new ComfyCloudError(
          `The Comfy Cloud job is ${job.status}; the video is not ready yet.`,
          { status: 409, code: 'job_not_ready' },
        );
      }
      const output = selectVideoOutput(job);
      const assetId = output.id;
      const upstream = await fetchAssetContent(assetId, { key, fetchImpl });
      const headers = new Headers();
      headers.set('Content-Type', output.contentType || 'video/mp4');
      headers.set('Content-Disposition', `attachment; filename="${safeFilename(output.name)}"`);
      headers.set('Cache-Control', 'no-store');
      return new Response(upstream.body, { status: 200, headers });
    }

    throw new ComfyCloudError('Comfy Cloud endpoint not found.', {
      status: 404,
      code: 'not_found',
    });
  } catch (error) {
    return errorResponse(error);
  }
}
