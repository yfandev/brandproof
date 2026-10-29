import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../cloud';
import { convertUiWorkflow } from '../workflowConvert';

function uiWorkflow() {
  return {
    nodes: [
      {
        id: 1,
        type: 'LoadImage',
        inputs: [],
        widgets_values_named: { image: 'packshot.png', upload: 'image' },
      },
      {
        id: 2,
        type: 'SaveVideo',
        inputs: [{ name: 'video', link: 102 }],
        widgets_values_named: {
          filename_prefix: 'brandproof/ltx',
          format: 'auto',
          'format.codec': 'auto',
        },
      },
      {
        id: 3,
        type: 'subgraph-node',
        inputs: [
          { name: 'input', link: 101 },
          { name: 'value', link: null, widget: { name: 'value' } },
        ],
        widgets_values_named: { value: 'A tube of cream', value_2: 768 },
      },
    ],
    links: [
      [101, 1, 0, 3, 0, 'IMAGE'],
      [102, 3, 0, 2, 0, 'VIDEO'],
    ],
    definitions: {
      subgraphs: [
        {
          id: 'subgraph-node',
          inputNode: { id: -10 },
          outputNode: { id: -20 },
          inputs: [{ name: 'input' }, { name: 'value' }],
          nodes: [
            {
              id: 10,
              type: 'CLIPTextEncode',
              inputs: [{ name: 'text', link: 201 }],
              widgets_values_named: { text: '' },
            },
            {
              id: 11,
              type: 'CLIPTextEncode',
              inputs: [],
              widgets_values_named: { text: 'blurry, low quality, watermark' },
            },
            {
              id: 12,
              type: 'ResizeImageMaskNode',
              inputs: [{ name: 'image', link: 202 }],
              widgets_values_named: {
                resize_type: 'scale dimensions',
                'resize_type.width': 768,
                'resize_type.height': 1152,
                'resize_type.crop': 'center',
                scale_method: 'lanczos',
              },
            },
            {
              id: 13,
              type: 'VHS_VideoCombine',
              inputs: [{ name: 'images', link: 203 }],
              widgets_values_named: { format: 'video/h264-mp4', save_output: true },
            },
          ],
          links: [
            { id: 201, origin_id: -10, origin_slot: 1, target_id: 10, target_slot: 0 },
            { id: 202, origin_id: -10, origin_slot: 0, target_id: 12, target_slot: 0 },
            { id: 203, origin_id: 12, origin_slot: 0, target_id: 13, target_slot: 0 },
            { id: 204, origin_id: 13, origin_slot: 0, target_id: -20, target_slot: 0 },
          ],
        },
      ],
    },
  };
}

describe('UI workflow conversion', () => {
  it('flattens a subgraph, maps its inputs and links its output', () => {
    const converted = convertUiWorkflow(uiWorkflow());
    expect(converted.workflow['1'].class_type).toBe('LoadImage');
    expect(converted.workflow['2'].class_type).toBe('SaveVideo');
    expect(converted.workflow['2'].inputs.video).toEqual(['sg3_13', 0]);
    expect(converted.workflow['sg3_12'].inputs.image).toEqual(['1', 0]);
    expect(converted.workflow['sg3_12'].inputs).toMatchObject({
      width: 768,
      height: 1152,
      crop: 'center',
    });
    expect(converted.workflow['sg3_13'].inputs.images).toEqual(['sg3_12', 0]);
    expect(converted.workflow['sg3_10'].inputs.text).toBe('A tube of cream');
    expect(converted.workflow['sg3_11']._meta?.title).toBe('Negative prompt');
    expect(converted.warnings).toHaveLength(0);
  });

  it('converts the UI workflow through the public parser', () => {
    const result = parseWorkflowJson(JSON.stringify(uiWorkflow()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.report.convertedFromUi).toBe(true);
    expect(result.parsed.report.imageNodes).toEqual(['1']);
    expect(result.parsed.report.negativeNodes).toEqual(['sg3_11']);
    const api = JSON.parse(result.parsed.apiWorkflowText) as Record<string, unknown>;
    expect(api['sg3_13']).toMatchObject({ class_type: 'VHS_VideoCombine' });
  });

  it('refuses a muted or bypassed UI node rather than producing a wrong graph', () => {
    const workflow = uiWorkflow();
    (workflow.nodes[0] as { mode?: number }).mode = 4;
    expect(() => convertUiWorkflow(workflow)).toThrow(/muted or bypassed/i);
  });
});
