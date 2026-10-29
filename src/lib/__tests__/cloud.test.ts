import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../cloud';

function workflow(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    '1': {
      class_type: 'LoadImage',
      inputs: { image: 'product.png' },
      _meta: { title: 'Product photo' },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'original prompt', clip: ['4', 0] },
      _meta: { title: 'Positive prompt' },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'original negative', clip: ['4', 0] },
      _meta: { title: 'Negative prompt' },
    },
    '4': {
      class_type: 'SaveVideo',
      inputs: { video: ['5', 0], filename_prefix: 'brandproof/ltx' },
      _meta: { title: 'Save video' },
    },
    ...overrides,
  });
}

describe('Comfy API-format workflow inspection', () => {
  it('finds the photo, positive prompt, negative prompt and video output', () => {
    const result = parseWorkflowJson(workflow());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.report.nodeCount).toBe(4);
    expect(result.parsed.report.imageNodes).toEqual(['1']);
    expect(result.parsed.report.promptNodes).toEqual(['2']);
    expect(result.parsed.report.negativeNodes).toEqual(['3']);
    expect(result.parsed.report.outputNodes).toEqual(['4']);
  });

  it('does not silently submit an empty UI workflow', () => {
    const result = parseWorkflowJson(JSON.stringify({ nodes: [], links: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no executable nodes');
  });

  it('rejects a workflow without a LoadImage input', () => {
    const parsed = JSON.parse(workflow());
    delete parsed['1'];
    const result = parseWorkflowJson(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('LoadImage');
  });

  it('rejects a workflow without a text prompt node', () => {
    const parsed = JSON.parse(workflow());
    delete parsed['2'];
    delete parsed['3'];
    const result = parseWorkflowJson(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('text prompt');
  });

  it('rejects a workflow without a video output', () => {
    const parsed = JSON.parse(workflow());
    parsed['4'].class_type = 'SaveImage';
    const result = parseWorkflowJson(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('SaveVideo');
  });

  it('warns when no negative prompt node can be identified', () => {
    const parsed = JSON.parse(workflow());
    parsed['3']._meta.title = 'Style prompt';
    const result = parseWorkflowJson(JSON.stringify(parsed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.report.promptNodes.sort()).toEqual(['2', '3']);
    expect(result.parsed.report.warnings[0]).toContain('negative-prompt');
  });
});
