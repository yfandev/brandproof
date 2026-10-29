import { describe, expect, it } from 'vitest';
import {
  bindWorkflow,
  handleComfyRequest,
  parseApiWorkflow,
  selectVideoOutput,
} from './comfy-cloud.js';

const KEY = 'comfyui-test-key';

function workflowText(overrides = {}) {
  return JSON.stringify({
    '1': { class_type: 'LoadImage', inputs: { image: 'product.png' } },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'old prompt', clip: ['4', 0] },
      _meta: { title: 'Positive prompt' },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'old negative', clip: ['4', 0] },
      _meta: { title: 'Negative prompt' },
    },
    '4': {
      class_type: 'SaveVideo',
      inputs: { video: ['5', 0], filename_prefix: 'brandproof/ltx' },
    },
    ...overrides,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function generateRequest(overrides = {}) {
  const form = new FormData();
  form.append('image', new File([new Uint8Array([137, 80, 78, 71])], 'packshot.png', { type: 'image/png' }));
  form.append('workflow', workflowText());
  form.append('prompt', 'Preserve the exact BOTANIKA label.');
  form.append('negative', 'distorted text');
  form.append('idempotencyKey', 'idem-12345678');
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return new Request('http://localhost/api/comfy/generate', { method: 'POST', body: form });
}

describe('Comfy Cloud server proxy', () => {
  it('reports the key as missing instead of attempting a request', async () => {
    const response = await handleComfyRequest(
      new Request('http://localhost/api/comfy/status'),
      {},
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ configured: false });
  });

  it('refuses generation without a server key', async () => {
    const response = await handleComfyRequest(generateRequest(), {});
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'comfy_not_configured' },
    });
  });

  it('uploads the photo, injects the prompt and submits a real v2 job', async () => {
    const calls = [];
    let submittedWorkflow = null;
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/api/v2/assets')) {
        expect(init.method).toBe('POST');
        expect(init.body).toBeInstanceOf(FormData);
        expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
        const fields = [...init.body.keys()];
        expect(fields).toContain('content_type');
        expect(fields).toContain('file_path');
        expect(fields.indexOf('content_type')).toBeLessThan(fields.indexOf('file'));
        expect(fields.indexOf('file_path')).toBeLessThan(fields.indexOf('file'));
        return jsonResponse(
          { id: 'asset_123', hash: 'blake3:abc', file_path: 'brandproof.png' },
          201,
        );
      }
      if (url.endsWith('/api/v2/jobs') && init.method === 'POST') {
        submittedWorkflow = JSON.parse(init.body).workflow;
        return jsonResponse({ id: 'job_123', status: 'queued', outputs: [] }, 201);
      }
      throw new Error(`Unexpected request ${url}`);
    };

    const response = await handleComfyRequest(generateRequest(), { COMFY_API_KEY: KEY }, {
      fetch: fetchImpl,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.jobId).toBe('job_123');
    expect(body.bindings).toContain('prompt → node 2');
    expect(submittedWorkflow['1'].inputs.image).toEqual({
      __type: 'core/ASSET',
      info: { id: 'asset_123', hash: 'blake3:abc', file_path: 'brandproof.png' },
    });
    expect(submittedWorkflow['2'].inputs.text).toBe('Preserve the exact BOTANIKA label.');
    expect(submittedWorkflow['3'].inputs.text).toBe('distorted text');
    expect(calls).toHaveLength(2);
  });

  it('polls a job and strips authenticated output URLs from the response', async () => {
    const fetchImpl = async (url, init = {}) => {
      expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(url).toBe('https://cloud.comfy.org/api/v2/jobs/job_123');
      return jsonResponse({
        id: 'job_123',
        status: 'running',
        queue_position: 2,
        progress: { value: 0.4, step: 12, steps: 30, message: 'KSampler 12/30' },
        outputs: [
          {
            id: 'out_pending',
            name: 'clip.mp4',
            type: 'video',
            content_type: 'video/mp4',
            url: 'https://cloud.comfy.org/api/v2/assets/out_pending/content',
          },
        ],
        error: null,
      });
    };

    const response = await handleComfyRequest(
      new Request('http://localhost/api/comfy/jobs/job_123'),
      { COMFY_API_KEY: KEY },
      { fetch: fetchImpl },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job).toMatchObject({
      id: 'job_123',
      status: 'running',
      queuePosition: 2,
      progress: { value: 0.4, step: 12, steps: 30 },
      outputs: [{ id: 'out_pending', name: 'clip.mp4', type: 'video' }],
    });
    expect(JSON.stringify(body)).not.toContain('cloud.comfy.org');
  });

  it('streams the finished MP4 without forwarding the API key to signed storage', async () => {
    const calls = [];
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (url === 'https://cloud.comfy.org/api/v2/jobs/job_123') {
        return jsonResponse({
          id: 'job_123',
          status: 'succeeded',
          queue_position: null,
          progress: { value: 1 },
          outputs: [
            {
              id: 'out_123',
              name: 'LTX_00001.mp4',
              type: 'video',
              content_type: 'video/mp4',
              url: 'https://cloud.comfy.org/api/v2/assets/out_123/content',
            },
          ],
          error: null,
        });
      }
      if (url === 'https://cloud.comfy.org/api/v2/assets/out_123/content') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://storage.example/signed/video.mp4' },
        });
      }
      if (url === 'https://storage.example/signed/video.mp4') {
        return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`Unexpected request ${url}`);
    };

    const response = await handleComfyRequest(
      new Request('http://localhost/api/comfy/jobs/job_123/video'),
      { COMFY_API_KEY: KEY },
      { fetch: fetchImpl },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('LTX_00001.mp4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(calls[1].init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[2].init.headers).toBeUndefined();
  });

  it('rejects an animated image instead of pretending it is a video', () => {
    expect(() =>
      selectVideoOutput({
        outputs: [{ id: 'out_gif', name: 'clip.gif', type: 'image', contentType: 'image/gif' }],
      }),
    ).toThrow(/animated image/i);
  });

  it('refuses a UI-format workflow before uploading', () => {
    expect(() => parseApiWorkflow(JSON.stringify({ nodes: [], links: [] }))).toThrow(
      /UI-format workflow/,
    );
  });

  it('binds the asset reference and prompt without mutating the source graph', () => {
    const parsed = parseApiWorkflow(workflowText());
    const bound = bindWorkflow(parsed, {
      asset: { id: 'asset_1', hash: 'blake3:abc', file_path: 'photo.png' },
      prompt: 'new prompt',
      negative: 'new negative',
      seed: 42,
    });
    expect(bound.workflow['1'].inputs.image.info.id).toBe('asset_1');
    expect(bound.workflow['2'].inputs.text).toBe('new prompt');
    expect(bound.touched).toContain('product photo → node 1');
    expect(parsed.workflow['1'].inputs.image).toBe('product.png');
  });
});
