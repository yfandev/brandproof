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
