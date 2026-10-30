import type { SceneId } from '../types';

export interface SceneDefinition {
  id: SceneId;
  name: string;
  blurb: string;
  direction: string;
  lighting: string;
  gradient: string;
}

export const SCENES: SceneDefinition[] = [
  {
    id: 'luxury-studio',
    name: 'Luxury Studio',
    blurb: 'Seamless cyclorama, hard key light, slow orbit.',
    direction:
      'a deep graphite studio cyclorama with a black acrylic plinth, the product centred and isolated, precise softbox key light from the left, thin rim highlight, controlled reflections, editorial beauty-ad polish',
    lighting: 'single large softbox key with a cool rim light, deep falloff, glossy floor reflection',
    gradient: 'linear-gradient(135deg, #2a2b31 0%, #101114 55%, #1d1f24 100%)',
  },
  {
    id: 'sunset-outdoors',
    name: 'Sunset Outdoors',
    blurb: 'Golden-hour ridge, warm rim light, gentle push-in.',
    direction:
      'a windswept coastal ridge at golden hour, warm sun low on the horizon, long shadows, dry grass moving in the breeze, product on a weathered stone ledge, cinematic 35mm commercial framing',
    lighting: 'backlit golden-hour sun, warm rim light, soft bounce fill, atmospheric haze',
    gradient: 'linear-gradient(135deg, #5b3a1f 0%, #24150f 55%, #3a2417 100%)',
  },
  {
    id: 'neon-city',
    name: 'Neon City',
    blurb: 'Rain-slick alley, magenta and cyan reflections.',
    direction:
      'a rain-slick neon alley at night, magenta and cyan signage reflecting in puddles, product on a wet ledge, slow dolly move through shallow depth of field, anamorphic flares and atmospheric haze',
    lighting: 'magenta and cyan practical neon, wet specular reflections, deep shadows with coloured highlights',
    gradient: 'linear-gradient(135deg, #3a1b46 0%, #0d0c1a 55%, #102f39 100%)',
  },
];

export function sceneById(id: SceneId): SceneDefinition {
  return SCENES.find((scene) => scene.id === id) ?? SCENES[0];
}

export const DEFAULT_NEGATIVE_PROMPT =
  'text artifacts, distorted lettering, gibberish text, misspelled brand name, extra labels, warped packaging, morphing logo, watermark, subtitles, captions, duplicate product, blurry label, low resolution, oversaturated, cartoon, dense fine print, printed paragraphs, columns of text, page texture, text-covered packaging, newspaper';

/**
 * Builds the editable generation prompt. It is intentionally explicit about
 * preserving the printed label; the model still gets no programmatic guarantee.
 */
export function buildPrompt(sceneId: SceneId, brand: string, labelText: string): string {
  const scene = sceneById(sceneId);
  const brandLine = brand.trim();
  const labelLines = labelText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const labelBlock = labelLines.length > 0 ? labelLines.join(' / ') : brandLine;
  const labelInstruction = labelBlock
    ? `The printed label on the product reads exactly: "${labelBlock}". Keep every letter of that label sharp, correctly spelled and unchanged in every frame.`
    : 'Keep the printed label sharp, correctly spelled and unchanged in every frame.';

  return [
    'Photoreal product advertising spot built from the uploaded reference photo.',
    brandLine
      ? `The product is ${brandLine}. Preserve its exact packaging shape, material, colour and proportions.`
      : 'Preserve the exact packaging shape, material, colour and proportions of the reference product.',
    labelInstruction,
    'Do not restyle, redraw, translate, extend or invent any label text, logo or typography.',
    labelBlock
      ? `That is the only printing on the packaging: "${labelBlock}". Everything else on the product surface is plain and unprinted — no extra words, fine print, paragraphs, columns of text, page-like texture, invented logos or certification marks.`
      : 'The packaging carries no printed text beyond the brand name — no extra words, fine print, paragraphs, columns of text, page-like texture, invented logos or certification marks.',
    'The printed label band occupies about a third of the package height; the packaging above and below it stays clean.',
    `Scene: ${scene.direction}.`,
    `Lighting: ${scene.lighting}.`,
    'Camera: one slow, controlled move (push-in with gentle parallax), product remaining in focus and occupying most of the frame, no camera shake.',
    'Finish: 16:9, commercial-grade colour, clean highlights, realistic motion blur.',
    'No captions, no subtitles, no watermarks, no additional text or logos beyond the product label.',
  ].join('\n');
}
