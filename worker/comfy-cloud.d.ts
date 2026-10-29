export interface ComfyWorkerEnv {
  COMFY_API_KEY?: string;
}

export interface ComfyHandleOptions {
  fetch?: typeof fetch;
}

export interface ApiWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export interface ApiWorkflowReport {
  nodeCount: number;
  promptNodes: string[];
  negativeNodes: string[];
  imageNodes: string[];
  outputNodes: string[];
  warnings: string[];
}

export interface ParsedApiWorkflow {
  workflow: Record<string, ApiWorkflowNode>;
  report: ApiWorkflowReport;
}

export interface WorkflowAsset {
  id: string;
  hash?: string;
  file_path?: string;
}

export interface WorkflowBindings {
  asset: WorkflowAsset;
  prompt: string;
  negative: string;
  seed?: number;
}

export interface BoundWorkflow {
  workflow: Record<string, ApiWorkflowNode>;
  touched: string[];
  report: ApiWorkflowReport;
}

export function parseApiWorkflow(text: string): ParsedApiWorkflow;

export function bindWorkflow(parsed: ParsedApiWorkflow, bindings: WorkflowBindings): BoundWorkflow;

export function handleComfyRequest(
  request: Request,
  env?: ComfyWorkerEnv,
  options?: ComfyHandleOptions,
): Promise<Response>;
