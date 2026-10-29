import type {
  CheckResult,
  CheckStatus,
  FrameSample,
  OcrWord,
  ReportConfig,
  ReportMetrics,
  Strictness,
  OcrPassInfo,
  OcrRegionSource,
  TokenEvidence,
  TokenFinding,
  TokenMatch,
  VerificationReport,
  VerifyConfig,
  VideoSource,
} from '../types';
import {
  assessLegibility,
  buildCandidates,
  buildExpectedTokens,
  classifyMatch,
  findExtraneousReadings,
  formatPercent,
  matchTokens,
  minConfidenceFor,
  thresholdFor,
} from './text';

export const SCHEMA_VERSION = 'brandproof.report/1';

const LIMITATIONS = [
  'OCR reads rendered pixels only. Very small, embossed, engraved, curved or motion-blurred label text may stay unreadable even when a human can read it.',
  'This is an automated consistency check across sampled frames, not proof that the product is identical in every frame or pixel.',
  'Palette similarity compares coarse colour distributions only. It is not a structural, geometric or identity check.',
  'Only the sampled frames are inspected, so incorrect text that appears between samples can be missed.',
  'The report is produced in your browser from local OCR output. It is not signed, notarised or tamper-proof.',
];

export function coverageTargetFor(config: VerifyConfig): number {
  return Math.max(0.2, Math.min(1, config.coverage));
}

export function requiredReadableFrames(sampleCount: number): number {
  return Math.max(2, Math.ceil(sampleCount * 0.4));
}

export interface FrameInput {
  index: number;
  time: number;
  dataUrl: string;
  width: number;
  height: number;
  paletteSimilarity: number | null;
  rawWords: OcrWord[];
  text: string;
  config: VerifyConfig;
  threshold: number;
  minWordConfidence: number;
  brandTokens: string[];
  labelTokens: string[];
  region: VerifyConfig['region'];
  ocrPasses?: OcrPassInfo[];
  ocrRegion?: VerifyConfig['region'];
  ocrRegionSource?: OcrRegionSource;
}

export function evaluateFrame(input: FrameInput): FrameSample {
  const legibility = assessLegibility(input.rawWords, input.minWordConfidence);
  const candidates = buildCandidates(input.rawWords);

  const brand: TokenMatch[] = matchTokens(
    input.brandTokens,
    candidates,
    input.threshold,
    input.minWordConfidence,
  ).map((match) => ({
    ...match,
    status: classifyMatch(match, input.threshold, legibility.legible),
  }));

  const label: TokenMatch[] = matchTokens(
    input.labelTokens,
    candidates,
    input.threshold,
    input.minWordConfidence,
  ).map((match) => ({
    ...match,
    status: classifyMatch(match, input.threshold, legibility.legible),
  }));

  // Words that are a close misspelling of required text. A render that prints the
  // correct and a garbled copy of the same word is not a match, even though every
  // required token was found. A token that was only read as a near-miss is left to
  // the distortion rule below, so it is never counted twice.
  const matchedTokens = new Set(
    [...brand, ...label].filter((token) => token.status === 'match').map((token) => token.expected),
  );
  const extraText = findExtraneousReadings(
    input.rawWords,
    [...input.brandTokens, ...input.labelTokens],
    input.minWordConfidence,
  ).filter((reading) => matchedTokens.has(reading.expected));

  const allBrandMatched = brand.length > 0 && brand.every((token) => token.status === 'match');
  const allLabelMatched = label.every((token) => token.status === 'match');
  const brandNear = brand.some((token) => token.status === 'near');
  const labelOk = label.length === 0 || !input.config.labelCritical || allLabelMatched;

  let status: FrameSample['status'] = 'review';
  if (!legibility.legible) {
    status = 'unreadable';
  } else if (brandNear) {
    status = 'fail';
  } else if (allBrandMatched && labelOk) {
    status = 'pass';
  } else if (allBrandMatched && label.length > 0) {
    status = 'review';
  }

  const notes: string[] = [];
  if (!legibility.legible) {
    notes.push('Not enough confident text to treat this frame as evidence.');
  }
  if (input.region) {
    notes.push('OCR was restricted to the manually selected label region.');
  }
  for (const token of brand) {
    if (token.status === 'near') {
      notes.push(
        `Brand token "${token.expected}" read as "${token.matched ?? '—'}" (${formatPercent(token.similarity)} similar).`,
      );
    } else if (token.status === 'missing' && legibility.legible) {
      notes.push(`Brand token "${token.expected}" was not found in the readable text.`);
    }
  }
  for (const token of label) {
    if (token.status === 'near') {
      notes.push(
        `Label token "${token.expected}" read as "${token.matched ?? '—'}" (${formatPercent(token.similarity)} similar) — visibly distorted.`,
      );
    } else if (token.status === 'missing' && legibility.legible) {
      notes.push(`Label token "${token.expected}" was not detected in this frame's readable text.`);
    }
  }
  for (const extra of extraText) {
    notes.push(
      `Extra lettering read as "${extra.text}" (${formatPercent(extra.similarity)} similar to the required "${extra.expected}") — a second, altered copy of expected text.`,
    );
  }

  return {
    index: input.index,
    time: input.time,
    dataUrl: input.dataUrl,
    width: input.width,
    height: input.height,
    paletteSimilarity: input.paletteSimilarity,
    words: input.rawWords,
    text: input.text,
    meanConfidence: legibility.meanConfidence,
    legible: legibility.legible,
    brand,
    label,
    extraText,
    status,
    notes,
    ocrPasses: input.ocrPasses,
    ocrRegion: input.ocrRegion ?? null,
    ocrRegionSource: input.ocrRegionSource ?? 'full-frame',
  };
}

function aggregateTokens(
  kind: 'brand' | 'label',
  tokens: string[],
  frames: FrameSample[],
  readableCount: number,
  coverage: number,
): TokenEvidence[] {
  return tokens.map((token) => {
    const matches = frames.map((frame) =>
      (kind === 'brand' ? frame.brand : frame.label).find((entry) => entry.expected === token),
    );
    const best = matches.reduce<TokenMatch | null>((current, entry) => {
      if (!entry) return current;
      if (!current || entry.similarity > current.similarity) return entry;
      return current;
    }, null);
    const hits = matches.filter((entry) => entry?.status === 'match').length;
    const near = matches.filter((entry) => entry?.status === 'near').length;
    const missing = matches.filter((entry) => entry?.status === 'missing').length;
    const unreadable = matches.filter((entry) => entry?.status === 'unreadable').length;
    return {
      token,
      kind,
      hits,
      near,
      missing,
      unreadable,
      bestReading: best?.matched ?? null,
      bestSimilarity: best ? Math.round(best.similarity * 1000) / 1000 : 0,
      bestConfidence: best?.confidence ?? null,
      finding: tokenFinding({ hits, near, missing, unreadable }, readableCount, coverage),
    };
  });
}

/**
 * Classifies a whole token without treating an OCR miss as a visual mismatch.
 * "visibly-distorted" requires repeated near-readings; one near reading is not
 * enough to claim the label changed.
 */
export function tokenFinding(
  counts: { hits: number; near: number; missing: number; unreadable: number },
  readableCount: number,
  coverage: number,
): TokenFinding {
  if (counts.hits > 0 && counts.hits >= Math.max(1, Math.ceil(readableCount * coverage))) {
    return 'verified';
  }
  if (counts.hits > 0) return 'detected';
  if (counts.near >= 2) return 'visibly-distorted';
  if (readableCount === 0) return 'insufficient-evidence';
  if (counts.near > 0) return 'insufficient-evidence';
  if (counts.missing > 0) return 'not-detected';
  if (counts.unreadable > 0) return 'unreadable';
  return 'insufficient-evidence';
}

function checkStatusPillLabel(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    case 'skipped':
      return 'skipped';
    default:
      return 'review';
  }
}

export function checkLabel(status: CheckStatus): string {
  return checkStatusPillLabel(status);
}

interface BuildReportInput {
  config: VerifyConfig;
  frames: FrameSample[];
  video: { name: string; source: VideoSource; duration: number };
  brandTokens: string[];
  labelTokens: string[];
  threshold: number;
  minWordConfidence: number;
  referenceSimilarity: number | null;
}

export function buildReport(input: BuildReportInput): VerificationReport {
  const { config, frames, brandTokens, labelTokens, threshold, minWordConfidence } = input;
  const readable = frames.filter((frame) => frame.legible);
  const readableCount = readable.length;
  const required = requiredReadableFrames(frames.length);
  const coverage = coverageTargetFor(config);

  const brandAllMatch = (frame: FrameSample) =>
    frame.brand.length > 0 && frame.brand.every((token) => token.status === 'match');
  const brandHits = readable.filter(brandAllMatch).length;
  const brandNearFrames = readable.filter(
    (frame) => !brandAllMatch(frame) && frame.brand.some((token) => token.status === 'near'),
  ).length;
  const labelAllMatch = (frame: FrameSample) => frame.label.every((token) => token.status === 'match');
  const labelHits = labelTokens.length > 0 ? readable.filter(labelAllMatch).length : null;

  const brandRecall = readableCount > 0 ? brandHits / readableCount : 0;
  const labelRecall = labelTokens.length > 0 && readableCount > 0 ? (labelHits ?? 0) / readableCount : null;
  const meanConfidence =
    readableCount > 0
      ? Math.round((readable.reduce((total, frame) => total + frame.meanConfidence, 0) / readableCount) * 10) / 10
      : 0;
  const readableFraction = frames.length > 0 ? readableCount / frames.length : 0;
  const paletteSimilarity = input.referenceSimilarity;

  const closestBrandReadings = Array.from(
    new Set(
      readable
        .flatMap((frame) => frame.brand)
        .filter((token) => token.status !== 'match' && token.matched)
        .sort((a, b) => b.similarity - a.similarity)
        .map((token) => `"${token.matched}"`),
    ),
  ).slice(0, 3);

  const checks: CheckResult[] = [];

  let brandCheck: CheckResult;
  if (readableCount === 0) {
    brandCheck = {
      id: 'brand',
      title: `Brand name “${config.brand}”`,
      status: 'review',
      critical: true,
      detail:
        'No sampled frame produced readable text, so brand fidelity could not be assessed. Mark the label region manually or use a sharper, slower clip.',
      metric: `0 / ${frames.length} readable frames`,
    };
  } else if (brandRecall >= coverage) {
    brandCheck = {
      id: 'brand',
      title: `Brand name “${config.brand}”`,
      status: 'pass',
      critical: true,
      detail: `Recognised in ${brandHits} of ${readableCount} readable frames (${formatPercent(brandRecall)}), meeting the ${formatPercent(coverage)} coverage target.`,
      metric: `${brandHits} / ${readableCount} readable frames`,
    };
  } else if (brandHits === 0 && readableCount >= 2 && meanConfidence >= 50) {
    brandCheck = {
      id: 'brand',
      title: `Brand name “${config.brand}”`,
      status: 'fail',
      critical: true,
      detail: `Text was read clearly in ${readableCount} frames, but the brand name never appeared.${
        closestBrandReadings.length > 0 ? ` Closest readings: ${closestBrandReadings.join(', ')}.` : ''
      }`,
      metric: `${brandHits} / ${readableCount} readable frames`,
    };
  } else if (brandNearFrames >= Math.max(2, Math.ceil(readableCount * 0.5)) && brandRecall < 0.5) {
    brandCheck = {
      id: 'brand',
      title: `Brand name “${config.brand}”`,
      status: 'fail',
      critical: true,
      detail: `The brand appears altered in ${brandNearFrames} of ${readableCount} readable frames.${
        closestBrandReadings.length > 0 ? ` Closest readings: ${closestBrandReadings.join(', ')}.` : ''
      }`,
      metric: `${brandNearFrames} altered / ${readableCount} readable frames`,
    };
  } else {
    brandCheck = {
      id: 'brand',
      title: `Brand name “${config.brand}”`,
      status: 'review',
      critical: true,
      detail: `Recognised in ${brandHits} of ${readableCount} readable frames (${formatPercent(brandRecall)}), below the ${formatPercent(coverage)} coverage target. More readable frames are needed to judge fidelity.`,
      metric: `${brandHits} / ${readableCount} readable frames`,
    };
  }
  checks.push(brandCheck);

  const labelEvidence = aggregateTokens('label', labelTokens, frames, readableCount, coverage);
  const distortedLabelTokens = labelEvidence.filter(
    (evidence) => evidence.finding === 'visibly-distorted',
  );
  const readLabelTokens = labelEvidence.filter(
    (evidence) => evidence.finding === 'verified' || evidence.finding === 'detected',
  );

  let labelCheck: CheckResult;
  if (labelTokens.length === 0) {
    labelCheck = {
      id: 'label',
      title: 'Printed label text',
      status: 'skipped',
      critical: false,
      detail: 'No label text was configured, so only the brand name and visual similarity were checked.',
      metric: 'not configured',
    };
  } else if (readableCount === 0) {
    labelCheck = {
      id: 'label',
      title: 'Printed label text',
      status: 'review',
      critical: config.labelCritical,
      detail: 'No readable frames were available for label comparison.',
      metric: `0 / ${frames.length} readable frames`,
    };
  } else if (distortedLabelTokens.length > 0) {
    labelCheck = {
      id: 'label',
      title: 'Printed label text',
      status: 'fail',
      critical: config.labelCritical,
      detail: `The brand was read, and ${distortedLabelTokens
        .map((evidence) => `“${evidence.token}” was read as “${evidence.bestReading ?? '—'}”`)
        .join(', ')} in multiple frames. Repeated near-readings are evidence of visible label distortion, not a single OCR miss.`,
      metric: `${distortedLabelTokens.length} / ${labelTokens.length} label tokens distorted`,
    };
  } else if (readLabelTokens.length === 0) {
    labelCheck = {
      id: 'label',
      title: 'Printed label text',
      status: 'review',
      critical: config.labelCritical,
      detail: `The brand was read, but none of the expected label tokens could be read in ${readableCount} readable frames. This is NOT DETECTED / insufficient evidence, not a confirmed mismatch. Mark the label area, choose a sharper clip, or use more frames.`,
      metric: `0 / ${readableCount} readable frames`,
    };
  } else if ((labelRecall ?? 0) >= coverage) {
    labelCheck = {
      id: 'label',
      title: 'Printed label text',
      status: 'pass',
      critical: config.labelCritical,
      detail: `All expected label tokens were read in ${labelHits ?? 0} of ${readableCount} readable frames (${formatPercent(labelRecall ?? 0)}), meeting the ${formatPercent(coverage)} coverage target.`,
      metric: `${labelHits ?? 0} / ${readableCount} readable frames`,
    };
  } else {
    labelCheck = {
      id: 'label',
      title: 'Printed label text',
      status: 'review',
      critical: config.labelCritical,
      detail: `Expected label tokens were read in ${labelHits ?? 0} of ${readableCount} readable frames (${formatPercent(labelRecall ?? 0)}), below the ${formatPercent(coverage)} coverage target. ${readLabelTokens.length} of ${labelTokens.length} label tokens were detected; inspect the per-token evidence before treating this as a change.`,
      metric: `${labelHits ?? 0} / ${readableCount} readable frames`,
    };
  }
  checks.push(labelCheck);

  const extraFrames = readable.filter((frame) => frame.extraText.length > 0);
  const extraReadings = Array.from(
    new Map(
      extraFrames.flatMap((frame) =>
        frame.extraText.map((extra) => [`${extra.text}→${extra.expected}`, extra] as const),
      ),
    ).values(),
  );
  const extraList = extraReadings
    .slice(0, 3)
    .map((extra) => `“${extra.text}” (≈ “${extra.expected}”)`)
    .join(', ');

  let extraCheck: CheckResult;
  if (readableCount === 0) {
    extraCheck = {
      id: 'extra-text',
      title: 'No duplicated lettering',
      status: 'review',
      critical: true,
      detail:
        'No readable frames were available, so duplicated or altered lettering artefact could not be ruled out.',
      metric: 'no readable frames',
    };
  } else if (extraFrames.length >= 2) {
    extraCheck = {
      id: 'extra-text',
      title: 'No duplicated lettering',
      status: 'fail',
      critical: true,
      detail: `Besides the required text, ${extraList} was also read in ${extraFrames.length} of ${readableCount} readable frames. The correct word and an altered near-copy appear in the same frames, which is evidence of duplicated or re-lettered text in the render rather than an OCR miss.`,
      metric: `${extraFrames.length} / ${readableCount} readable frames`,
    };
  } else if (extraFrames.length === 1) {
    extraCheck = {
      id: 'extra-text',
      title: 'No duplicated lettering',
      status: 'review',
      critical: true,
      detail: `${extraList} was read once alongside the required text. A single frame is not enough to call a change, so this needs a human look.`,
      metric: `1 / ${readableCount} readable frames`,
    };
  } else {
    extraCheck = {
      id: 'extra-text',
      title: 'No duplicated lettering',
      status: 'pass',
      critical: true,
      detail: 'No altered near-copy of the required words was read in any readable frame.',
      metric: `0 / ${readableCount} readable frames`,
    };
  }
  checks.push(extraCheck);

  let legibilityStatus: CheckStatus = 'review';
  if (readableFraction >= 0.7 && meanConfidence >= 55) legibilityStatus = 'pass';
  else if (readableFraction < 0.35) legibilityStatus = 'fail';
  checks.push({
    id: 'legibility',
    title: 'OCR legibility',
    status: legibilityStatus,
    critical: false,
    detail:
      readableCount === 0
        ? 'Tesseract could not read text in any sampled frame. Try a tighter label region, a higher-resolution clip, or a close-up where the label fills more of the frame.'
        : `${readableCount} of ${frames.length} sampled frames produced confident text (mean confidence ${meanConfidence}). Low legibility turns the verdict into REVIEW rather than a false FAIL.`,
    metric: `${readableCount} / ${frames.length} frames readable`,
  });

  if (paletteSimilarity === null) {
    checks.push({
      id: 'palette',
      title: 'Colour profile vs reference photo',
      status: 'skipped',
      critical: false,
      detail: 'No product reference photo was available for the visual comparison.',
      metric: 'no reference',
    });
  } else {
    checks.push({
      id: 'palette',
      title: 'Colour profile vs reference photo',
      status: paletteSimilarity >= 0.5 ? 'pass' : 'review',
      critical: false,
      detail: `Coarse histogram overlap between the reference photo and the sampled frames is ${formatPercent(paletteSimilarity)}. A different scene legitimately changes the palette, so this is advisory and never forces FAIL.${
        config.region ? ' Computed over the selected label region.' : ''
      }`,
      metric: `${formatPercent(paletteSimilarity)} overlap`,
    });
  }

  const criticalFail = checks.some((check) => check.critical && check.status === 'fail');
  const criticalPass = checks.filter((check) => check.critical).every((check) => check.status === 'pass');
  const labelBlocksPass =
    labelCheck.status === 'pass' || labelCheck.status === 'skipped' || labelTokens.length === 0;
  const enoughEvidence = readableCount >= required && legibilityStatus === 'pass';

  let verdict: VerificationReport['verdict'];
  let headline: string;
  let summary: string;

  if (criticalFail) {
    verdict = 'FAIL';
    const failed = checks.filter((check) => check.critical && check.status === 'fail').map((check) => check.title);
    headline = 'Fidelity break detected';
    summary = `${failed.join(' and ')} failed a configured critical check across ${frames.length} sampled frames. Open the frame evidence below to see the recognised text and boxes.`;
  } else if (criticalPass && enoughEvidence && labelBlocksPass) {
    verdict = 'PASS';
    headline = 'Brand integrity holds';
    summary = `The brand was recognised in ${brandHits} of ${readableCount} readable frames${labelTokens.length > 0 ? `, and every configured label token was read in ${labelHits ?? 0}` : ''}. Evidence meets the ${formatPercent(coverage)} coverage target. This is an automated OCR consistency check, not proof of pixel-level identity.`;
  } else {
    verdict = 'REVIEW';
    headline = 'Needs a human check';
    const reasons: string[] = [];
    if (readableCount < required) reasons.push(`only ${readableCount} of ${frames.length} frames were readable (${required} needed)`);
    if (!brandCheck.status.match(/pass/)) reasons.push('brand coverage is incomplete');
    if (labelCheck.status === 'review') reasons.push('label text was only partially matched');
    if (extraCheck.status === 'review') reasons.push('an altered copy of required lettering appeared in one frame');
    if (legibilityStatus !== 'pass') reasons.push('OCR confidence is limited');
    if (reasons.length === 0) reasons.push('the sampled evidence is not conclusive');
    summary = `Verification is inconclusive because ${reasons.join('; ')}. No critical check demonstrably failed, so this is not a FAIL. Inspect the frames or mark the label region and run again.`;
  }

  const metrics: ReportMetrics = {
    sampledFrames: frames.length,
    readableFrames: readableCount,
    requiredReadableFrames: required,
    brandHits,
    brandRecall: Math.round(brandRecall * 1000) / 1000,
    labelHits,
    labelRecall: labelRecall === null ? null : Math.round(labelRecall * 1000) / 1000,
    meanConfidence,
    readableFraction: Math.round(readableFraction * 1000) / 1000,
    paletteSimilarity: paletteSimilarity === null ? null : Math.round(paletteSimilarity * 1000) / 1000,
    coverageTarget: coverage,
  };

  const reportConfig: ReportConfig = {
    ...config,
    threshold,
    minWordConfidence,
    brandTokens,
    labelTokens,
  };

  return {
    app: 'BrandProof',
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    verdict,
    headline,
    summary,
    config: reportConfig,
    video: input.video,
    checks,
    metrics,
    tokenEvidence: [
      ...aggregateTokens('brand', brandTokens, frames, readableCount, coverage),
      ...aggregateTokens('label', labelTokens, frames, readableCount, coverage),
    ],
    frames,
    limitations: LIMITATIONS,
  };
}

export function reportInputs(config: VerifyConfig) {
  const { brandTokens, labelTokens } = buildExpectedTokens(config.brand, config.labelText);
  return {
    brandTokens,
    labelTokens,
    threshold: thresholdFor(config.strictness as Strictness),
    minWordConfidence: minConfidenceFor(config.strictness as Strictness),
  };
}
