/**
 * Converts a ComfyUI/Comfy Cloud UI workflow (the JSON with nodes + links) to
 * an API-format graph. Newer Comfy frontends include widgets_values_named,
 * which makes this possible without the server's /object_info definitions.
 *
 * This is deliberately strict: unsupported UI-only nodes or missing values
 * produce an error instead of a silently wrong graph.
 */

export interface ConvertedApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export interface UiConversionResult {
  workflow: Record<string, ConvertedApiNode>;
  warnings: string[];
}

interface UiNode {
  id: number;
  type: string;
  title?: string;
  mode?: number;
  inputs?: Array<{ name?: string; link?: number | null; widget?: { name?: string } }>;
  widgets_values_named?: Record<string, unknown>;
  widgets_values?: unknown[];
}

interface UiLink {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
}

interface UiSubgraph {
  id: string;
  nodes?: UiNode[];
  links?: unknown[];
  inputs?: Array<{ name?: string; label?: string }>;
  outputNode?: { id?: number };
  inputNode?: { id?: number };
}

interface UiWorkflow {
  nodes?: UiNode[];
  links?: unknown[];
  definitions?: { subgraphs?: UiSubgraph[] };
}

const UI_ONLY_NODES = new Set(['MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode']);
const NEGATIVE_TEXT =
  /blurry|low quality|still frame|watermark|subtitles|overlay|titles|pc game|console game|video game|cartoon|childish|ugly|misspelled/i;

function asNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLink(raw: unknown): UiLink | null {
  if (Array.isArray(raw)) {
    const [id, originId, originSlot, targetId, targetSlot] = raw;
    const link = {
      id: asNumber(id),
      origin_id: asNumber(originId),
      origin_slot: asNumber(originSlot),
      target_id: asNumber(targetId),
      target_slot: asNumber(targetSlot),
    };
    if (Object.values(link).some((value) => value === null)) return null;
    return link as UiLink;
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const link = {
      id: asNumber(record.id),
      origin_id: asNumber(record.origin_id),
      origin_slot: asNumber(record.origin_slot),
      target_id: asNumber(record.target_id),
      target_slot: asNumber(record.target_slot),
    };
    if (Object.values(link).some((value) => value === null)) return null;
    return link as UiLink;
  }
  return null;
}

function normalizeLinks(raw: unknown): UiLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeLink).filter((link): link is UiLink => Boolean(link));
}

function namedValues(node: UiNode): Record<string, unknown> {
  return node.widgets_values_named && typeof node.widgets_values_named === 'object'
    ? { ...node.widgets_values_named }
    : {};
}

function primitiveValue(node: UiNode): unknown {
  const named = namedValues(node);
  if ('value' in named) return named.value;
  return Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
}

function nodeTitle(node: UiNode): string | undefined {
  return typeof node.title === 'string' && node.title.trim() ? node.title : undefined;
}

function flatInputName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

function baseInputs(node: UiNode): Record<string, unknown> {
  const inputs = namedValues(node);
  delete inputs.upload;
  // Comfy's UI uses dotted keys for conditional widget groups (for example
  // resize_type.crop and sampling_mode.min_p). The API graph expects the
  // field without the group prefix.
  for (const key of Object.keys(inputs)) {
    if (!key.includes('.')) continue;
    const flat = flatInputName(key);
    if (!flat) {
      delete inputs[key];
      continue;
    }
    if (flat in inputs && inputs[flat] !== inputs[key]) {
      throw new Error(
        `Node ${node.id} has conflicting widget values for "${flat}" (${key}).`,
      );
    }
    if (!(flat in inputs)) inputs[flat] = inputs[key];
    delete inputs[key];
  }
  if (node.type === 'LoadImage') {
    const image = inputs.image ?? (Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined);
    inputs.image = typeof image === 'string' ? image : 'product.png';
  }
  return inputs;
}

function apiNode(node: UiNode): ConvertedApiNode {
  const inputs = baseInputs(node);
  if (
    /CLIPTextEncode/i.test(node.type) &&
    typeof inputs.text === 'string' &&
    NEGATIVE_TEXT.test(inputs.text)
  ) {
    return {
      class_type: node.type,
      inputs,
      _meta: { title: 'Negative prompt' },
    };
  }
  const title = nodeTitle(node);
  return {
    class_type: node.type,
    inputs,
    ...(title ? { _meta: { title } } : {}),
  };
}

export function convertUiWorkflow(raw: unknown): UiConversionResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('The UI workflow must be a JSON object.');
  }
  const ui = raw as UiWorkflow;
  if (!Array.isArray(ui.nodes)) {
    throw new Error('The UI workflow has no "nodes" array.');
  }

  const warnings: string[] = [];
  const subgraphs = new Map<string, UiSubgraph>();
  for (const subgraph of ui.definitions?.subgraphs ?? []) {
    if (subgraph && typeof subgraph.id === 'string') subgraphs.set(subgraph.id, subgraph);
  }

  const topNodes = new Map<number, UiNode>();
  for (const node of ui.nodes) {
    if (Number.isFinite(node.id)) topNodes.set(node.id, node);
  }
  const topLinks = normalizeLinks(ui.links);
  const topLinkByTarget = new Map<string, UiLink>();
  for (const link of topLinks) {
    topLinkByTarget.set(`${link.target_id}:${link.target_slot}`, link);
  }

  const workflow: Record<string, ConvertedApiNode> = {};
  const subgraphOutputs = new Map<number, Record<number, unknown>>();
  const converting = new Set<string>();

  const checkSupported = (node: UiNode) => {
    if (node.mode === 2 || node.mode === 4) {
      throw new Error(
        `Node ${node.id} (${node.type}) is muted or bypassed in the UI workflow. Enable it before generating, or export the API workflow from Comfy Cloud.`,
      );
    }
    if (UI_ONLY_NODES.has(node.type)) return false;
    if (node.type === 'GetNode' || node.type === 'SetNode') {
      throw new Error(
        `Node ${node.id} uses ${node.type}. BrandProof does not expand Get/Set nodes; export the API workflow instead.`,
      );
    }
    return true;
  };

  const resolveTop = (originId: number, originSlot: number): unknown => {
    const origin = topNodes.get(originId);
    if (!origin) throw new Error(`The UI workflow link points to missing node ${originId}.`);
    if (subgraphs.has(origin.type)) {
      const outputs = subgraphOutputs.get(originId);
      if (!outputs || !(originSlot in outputs)) {
        throw new Error(`The subgraph output ${originId}:${originSlot} is not connected.`);
      }
      return outputs[originSlot];
    }
    if (origin.type === 'Reroute') {
      const linkId = origin.inputs?.[0]?.link;
      const link = topLinks.find((candidate) => candidate.id === linkId);
      if (!link) throw new Error(`Reroute node ${origin.id} has no input link.`);
      return resolveTop(link.origin_id, link.origin_slot);
    }
    if (origin.type === 'PrimitiveNode') return primitiveValue(origin);
    return [String(origin.id), originSlot];
  };

  const expandSubgraph = (node: UiNode, definition: UiSubgraph, prefix: string): Record<number, unknown> => {
    if (converting.has(definition.id)) {
      throw new Error(`The subgraph ${definition.id} contains a recursive reference.`);
    }
    converting.add(definition.id);
    try {
      const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
      const byId = new Map<number, UiNode>();
      for (const internal of nodes) {
        if (Number.isFinite(internal.id)) byId.set(internal.id, internal);
      }
      const links = normalizeLinks(definition.links);
      const linkById = new Map(links.map((link) => [link.id, link]));
      const inputNodeId = definition.inputNode?.id ?? -10;
      const outputNodeId = definition.outputNode?.id ?? -20;

      const inputSources: Record<number, unknown> = {};
      for (let index = 0; index < (definition.inputs?.length ?? 0); index += 1) {
        const external = topLinkByTarget.get(`${node.id}:${index}`);
        if (external) {
          inputSources[index] = resolveTop(external.origin_id, external.origin_slot);
          continue;
        }
        const inputName = definition.inputs?.[index]?.name;
        const value = inputName
          ? node.widgets_values_named?.[inputName]
          : node.widgets_values?.[index];
        if (value !== undefined) inputSources[index] = value;
      }

      const resolveInternal = (originId: number, originSlot: number): unknown => {
        if (originId === inputNodeId) {
          if (!(originSlot in inputSources)) {
            throw new Error(
              `The subgraph input ${originSlot} has no value. Connect it or set its widget before exporting.`,
            );
          }
          return inputSources[originSlot];
        }
        const origin = byId.get(originId);
        if (!origin) throw new Error(`The subgraph link points to missing node ${originId}.`);
        if (origin.type === 'Reroute') {
          const linkId = origin.inputs?.[0]?.link;
          const link = linkId == null ? null : linkById.get(linkId);
          if (!link) throw new Error(`Reroute node ${origin.id} has no input link.`);
          return resolveInternal(link.origin_id, link.origin_slot);
        }
        if (origin.type === 'PrimitiveNode') return primitiveValue(origin);
        return [`${prefix}${originId}`, originSlot];
      };

      const outputs: Record<number, unknown> = {};
      for (const link of links) {
        if (link.target_id === outputNodeId) {
          outputs[link.target_slot] = resolveInternal(link.origin_id, link.origin_slot);
        }
      }

      for (const internal of nodes) {
        if (!checkSupported(internal)) continue;
        const api = apiNode(internal);
        for (const input of internal.inputs ?? []) {
          if (input.link == null || !input.name) continue;
          const link = linkById.get(input.link);
          if (!link) continue;
          api.inputs[flatInputName(input.name)] = resolveInternal(link.origin_id, link.origin_slot);
        }
        workflow[`${prefix}${internal.id}`] = api;
      }
      return outputs;
    } finally {
      converting.delete(definition.id);
    }
  };

  // Expand every subgraph first so top-level consumers can resolve its outputs.
  for (const node of ui.nodes) {
    const definition = subgraphs.get(node.type);
    if (!definition) continue;
    if (!checkSupported(node)) continue;
    subgraphOutputs.set(
      node.id,
      expandSubgraph(node, definition, `sg${node.id}_`),
    );
  }

  for (const node of ui.nodes) {
    if (subgraphs.has(node.type) || !checkSupported(node)) continue;
    const api = apiNode(node);
    for (const input of node.inputs ?? []) {
      if (input.link == null || !input.name) continue;
      const link = topLinks.find((candidate) => candidate.id === input.link);
      if (!link) continue;
      api.inputs[flatInputName(input.name)] = resolveTop(link.origin_id, link.origin_slot);
    }
    workflow[String(node.id)] = api;
  }

  for (const node of Object.values(workflow)) {
    if (!/CLIPTextEncode/i.test(node.class_type)) continue;
    if (typeof node.inputs.text !== 'string') continue;
    if (NEGATIVE_TEXT.test(node.inputs.text) && !/neg/i.test(node._meta?.title ?? '')) {
      node._meta = { ...node._meta, title: 'Negative prompt' };
    }
  }

  if (Object.keys(workflow).length === 0) {
    throw new Error('The UI workflow produced no executable nodes.');
  }
  return { workflow, warnings };
}
