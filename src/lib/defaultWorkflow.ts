import workflow from '../workflows/ltx23_i2v.json';

/**
 * BrandProof ships with the LTX-2.3 image-to-video workflow used by the app.
 * It is UI format, so the browser converts it to an API graph before the
 * Worker submits it. Keeping it bundled means the normal flow never asks the
 * user to find, export or paste a workflow file.
 */
export const DEFAULT_WORKFLOW_NAME = 'LTX-2.3 Image to Video';
export const DEFAULT_WORKFLOW_TEXT = JSON.stringify(workflow);
