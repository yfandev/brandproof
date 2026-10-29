import { afterEach, describe, expect, it, vi } from 'vitest';
import template from '../../../comfy/workflows/wan22_ti2v_api.json';
import {
  bindWorkflow,
  comfyDimensionsFor,
  extractVideoRef,
  normalizeBaseUrl,
  parseWorkflow,
  waitForComfyVideo,
  type Workflow,
} from '../comfy';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('workflow parsing and binding', () => {
  it('normalizes endpoints', () => {
    expect(normalizeBaseUrl('127.0.0.1:8188/')).toBe('http://127.0.0.1:8188');
    expect(normalizeBaseUrl('https://comfy.example.com/')).toBe('https://comfy.example.com');
    expect(() => normalizeBaseUrl('')).toThrow();
  });

  it('rejects UI-format workflows with a helpful message', () => {
    expect(() => parseWorkflow(JSON.stringify({ nodes: [] }))).toThrow(/UI-format/);
    expect(() => parseWorkflow('not json')).toThrow(/could not be parsed/);
    expect(() => parseWorkflow(JSON.stringify({ '1': { inputs: {} } }))).toThrow(/class_type/);
  });

  it('injects prompt, image, dimensions, seed and output prefix into the bundled Wan workflow', () => {
    const bound = bindWorkflow(template as unknown as Workflow, {
      imageName: 'brandproof-reference.png',
      positive: 'POSITIVE PROMPT',
      negative: 'NEGATIVE PROMPT',
      seed: 1234,
      width: 832,
      height: 480,
      frames: 81,
      filenamePrefix: 'brandproof/test',
    });

    expect(bound.workflow['6'].inputs.text).toBe('POSITIVE PROMPT');
    expect(bound.workflow['7'].inputs.text).toBe('NEGATIVE PROMPT');
    expect(bound.workflow['56'].inputs.image).toBe('brandproof-reference.png');
    expect(bound.workflow['55'].inputs.width).toBe(832);
    expect(bound.workflow['55'].inputs.height).toBe(480);
    expect(bound.workflow['55'].inputs.length).toBe(81);
    expect(bound.workflow['3'].inputs.seed).toBe(1234);
    expect(bound.workflow['58'].inputs.filename_prefix).toBe('brandproof/test');
    expect(bound.workflow['58'].inputs.format).toBe('mp4');
    expect(bound.warnings).toHaveLength(0);
    // The source template must stay untouched.
    expect((template as unknown as Workflow)['6'].inputs.text).not.toBe('POSITIVE PROMPT');
  });

  it('refuses workflows that cannot use the product photo', () => {
    const workflow = parseWorkflow(
      JSON.stringify({
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'hello', clip: ['2', 0] } },
        '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'x' } },
      }),
    );
    expect(() =>
      bindWorkflow(workflow, {
        imageName: 'ref.png',
        positive: 'a',
        negative: 'b',
        seed: 1,
        width: 832,
        height: 480,
        frames: 49,
        filenamePrefix: 'x',
      }),
    ).toThrow(/LoadImage/);
  });

  it('derives stable Wan-friendly dimensions from the photo aspect ratio', () => {
    expect(comfyDimensionsFor(1600, 900)).toEqual({ width: 832, height: 480 });
    expect(comfyDimensionsFor(900, 1600)).toEqual({ width: 480, height: 832 });
    expect(comfyDimensionsFor(1000, 1000)).toEqual({ width: 640, height: 640 });
  });
});

describe('output extraction', () => {
  it('prefers a real video over an animated image', () => {
    const result = extractVideoRef({
      '58': {
        images: [
          { filename: 'clip.webp', subfolder: '', type: 'output' },
          { filename: 'clip.mp4', subfolder: 'brandproof', type: 'output' },
        ],
      },
    });
    expect(result.video?.filename).toBe('clip.mp4');
    expect(result.animated?.filename).toBe('clip.webp');
  });
});

describe('history polling', () => {
  it('returns the generated video file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          'prompt-1': {
            status: { status_str: 'success', completed: true },
            outputs: { '58': { images: [{ filename: 'clip.mp4', subfolder: 'brandproof', type: 'output' }] } },
          },
        }),
      ),
    );

    const ref = await waitForComfyVideo('http://127.0.0.1:8188', 'prompt-1', { pollMs: 1 });
    expect(ref).toEqual({ filename: 'clip.mp4', subfolder: 'brandproof', type: 'output' });
  });

  it('surfaces ComfyUI execution errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          'prompt-2': {
            status: {
              status_str: 'error',
              completed: false,
              messages: [
                ['execution_error', { exception_message: 'CUDA out of memory', node_id: '3', node_type: 'KSampler' }],
              ],
            },
            outputs: {},
          },
        }),
      ),
    );

    await expect(waitForComfyVideo('http://127.0.0.1:8188', 'prompt-2', { pollMs: 1 })).rejects.toThrow(
      /CUDA out of memory/,
    );
  });

  it('rejects animated images instead of pretending they are video', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          'prompt-3': {
            status: { status_str: 'success', completed: true },
            outputs: { '58': { images: [{ filename: 'clip.webp', subfolder: '', type: 'output' }] } },
          },
        }),
      ),
    );

    await expect(waitForComfyVideo('http://127.0.0.1:8188', 'prompt-3', { pollMs: 1 })).rejects.toThrow(
      /animated image/,
    );
  });

  it('reports an unreachable server clearly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(waitForComfyVideo('http://127.0.0.1:8188', 'prompt-4', { pollMs: 1 })).rejects.toThrow(
      /Could not reach ComfyUI/,
    );
  });
});
