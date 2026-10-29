import { describe, expect, it } from 'vitest';
import { bindWorkflow, parseApiWorkflow } from '../../../worker/comfy-cloud.js';
import { parseWorkflowJson } from '../cloud';
import { DEFAULT_WORKFLOW_TEXT, DEFAULT_WORKFLOW_NAME } from '../defaultWorkflow';

describe('bundled LTX-2.3 workflow', () => {
  it('converts the shipped UI workflow into a runnable API graph', () => {
    const result = parseWorkflowJson(DEFAULT_WORKFLOW_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = result.parsed.report;
    expect(DEFAULT_WORKFLOW_NAME).toContain('LTX-2.3');
    expect(report.convertedFromUi).toBe(true);
    expect(report.imageNodes.length).toBeGreaterThan(0);
    expect(report.promptNodes.length).toBeGreaterThan(0);
    expect(report.negativeNodes.length).toBeGreaterThan(0);
    expect(report.outputNodes.length).toBeGreaterThan(0);
    expect(report.nodeCount).toBeGreaterThan(20);
  });

  it('keeps the photo, prompt and save nodes in the submitted graph', () => {
    const result = parseWorkflowJson(DEFAULT_WORKFLOW_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const api = JSON.parse(result.parsed.apiWorkflowText) as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    const imageId = result.parsed.report.imageNodes[0];
    const outputId = result.parsed.report.outputNodes[0];
    expect(api[imageId].class_type).toBe('LoadImage');
    expect(api[outputId].class_type).toBe('SaveVideo');
    const saveInput = api[outputId].inputs.video;
    expect(Array.isArray(saveInput)).toBe(true);
    expect(api[(saveInput as [string, number])[0]]).toBeDefined();
  });

  it('flattens conditional widget groups into the API input names', () => {
    const result = parseWorkflowJson(DEFAULT_WORKFLOW_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const api = JSON.parse(result.parsed.apiWorkflowText) as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    for (const [id, node] of Object.entries(api)) {
      expect({ id, dotted: Object.keys(node.inputs).filter((key) => key.includes('.')) }).toEqual({
        id,
        dotted: [],
      });
    }

    const resizers = Object.values(api).filter(
      (node) => node.class_type === 'ResizeImageMaskNode',
    );
    expect(resizers.length).toBeGreaterThan(0);
    for (const node of resizers) {
      if (node.inputs.resize_type === 'scale dimensions') {
        expect(node.inputs).toHaveProperty('crop');
        expect(node.inputs).toHaveProperty('width');
        expect(node.inputs).toHaveProperty('height');
      }
      if (node.inputs.resize_type === 'scale longer dimension') {
        expect(node.inputs).toHaveProperty('longer_size');
      }
    }

    const enhancer = Object.values(api).find(
      (node) => node.class_type === 'TextGenerateLTX2Prompt',
    );
    expect(enhancer?.inputs).toMatchObject({
      sampling_mode: 'on',
      temperature: 0.7,
      top_k: 64,
      top_p: 0.95,
      min_p: 0.05,
      repetition_penalty: 1.05,
      seed: 0,
      presence_penalty: 0,
    });
  });

  it('binds the product photo, prompt and negative prompt on the server', () => {
    const result = parseWorkflowJson(DEFAULT_WORKFLOW_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseApiWorkflow(result.parsed.apiWorkflowText);
    const prompt = 'BRANDPROOF PRODUCT SHOT';
    const negative = 'distorted label';
    const bound = bindWorkflow(parsed, {
      asset: { id: 'asset-1', hash: 'blake3:abc', file_path: 'product.png' },
      prompt,
      negative,
      seed: 42,
    });

    for (const id of parsed.report.promptNodes) {
      expect(bound.workflow[id].inputs.text).toBe(prompt);
    }
    for (const id of parsed.report.negativeNodes) {
      expect(bound.workflow[id].inputs.text).toBe(negative);
    }
    for (const id of parsed.report.imageNodes) {
      expect(bound.workflow[id].inputs.image).toMatchObject({
        __type: 'core/ASSET',
        info: { id: 'asset-1' },
      });
    }
    expect(parsed.report.outputNodes.length).toBeGreaterThan(0);
  });
});
