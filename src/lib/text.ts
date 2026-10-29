import type { Bbox, OcrWord, Strictness, TokenMatch, TokenStatus } from '../types';

/**
 * Normalize text for OCR comparison:
 * - strip diacritics, unify quotes/dashes
 * - lowercase everything
 * - collapse anything that is not a latin letter or digit into a space
 *
 * We deliberately keep this simple and language-agnostic for English labels.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐-‒–—―]/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized.split(' ') : [];
}

export function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens.filter((token) => token.length > 0)));
}

export interface ExpectedTokens {
  brandTokens: string[];
  labelTokens: string[];
}

/**
 * Brand tokens are always checked. Label tokens exclude words already covered by
 * the brand name so a token is never counted twice in the report.
 */
export function buildExpectedTokens(brand: string, labelText: string): ExpectedTokens {
  const brandTokens = uniqueTokens(tokenize(brand));
  const brandSet = new Set(brandTokens);
  const labelTokens = uniqueTokens(tokenize(labelText)).filter((token) => !brandSet.has(token));
  return { brandTokens, labelTokens };
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/** Normalized edit similarity in the range 0..1. */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const longest = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Compare one expected token with one OCR candidate.
 * Exact match wins; containment is scored slightly below an exact match so a
 * brand read as "LUMINALUXE" still matches "lumina", while unrelated words do not.
 */
export function tokenScore(expected: string, candidate: string): number {
  if (!expected || !candidate) return 0;
  if (expected === candidate) return 1;
  let score = similarity(expected, candidate);
  if (expected.length >= 4 && candidate.includes(expected)) {
    score = Math.max(score, 0.91);
  } else if (candidate.length >= 4 && expected.includes(candidate)) {
    score = Math.max(score, 0.72);
  }
  return score;
}

function unionBbox(a: Bbox, b: Bbox): Bbox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function splitAlphaNumeric(token: string): string[] {
  const parts = token.match(/[a-z]+|[0-9]+/g);
  return parts && parts.length > 1 ? parts : [];
}

/**
 * Build the candidate list used for matching. OCR often merges or splits words
 * ("BRAND PROOF", "20ML", "20 ml"), so we add alphanumeric splits and adjacent
 * word joins (only within the same text line). Raw words stay untouched for display.
 */
export function buildCandidates(words: OcrWord[]): OcrWord[] {
  const ordered = words
    .map((word) => ({ ...word, normalized: word.normalized || normalizeText(word.text) }))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0 || a.bbox.y1 - b.bbox.y1);

  const candidates: OcrWord[] = [...ordered];

  for (const word of ordered) {
    for (const part of splitAlphaNumeric(word.normalized)) {
      candidates.push({ ...word, text: part, normalized: part });
    }
  }

  for (let i = 0; i < ordered.length; i += 1) {
    let joined = ordered[i].normalized;
    let bbox = ordered[i].bbox;
    let confidence = ordered[i].confidence;
    for (let j = i + 1; j < Math.min(i + 3, ordered.length); j += 1) {
      const previous = ordered[j - 1];
      const next = ordered[j];
      const previousHeight = previous.bbox.y1 - previous.bbox.y0;
      const nextHeight = next.bbox.y1 - next.bbox.y0;
      const previousCenter = (previous.bbox.y0 + previous.bbox.y1) / 2;
      const nextCenter = (next.bbox.y0 + next.bbox.y1) / 2;
      const sameLine = Math.abs(previousCenter - nextCenter) <= Math.max(previousHeight, nextHeight) * 0.7;
      if (!sameLine || next.bbox.x0 < previous.bbox.x0) break;
      joined = `${joined}${next.normalized}`;
      bbox = unionBbox(bbox, next.bbox);
      confidence = Math.min(confidence, next.confidence);
      candidates.push({
        text: joined,
        normalized: joined,
        confidence,
        bbox,
      });
    }
  }

  return candidates;
}

export function matchTokens(
  expectedTokens: string[],
  candidates: OcrWord[],
  threshold: number,
  minWordConfidence: number,
): TokenMatch[] {
  const usable = candidates.filter(
    (candidate) => candidate.confidence >= minWordConfidence && candidate.normalized.length > 0,
  );

  return expectedTokens.map((expected) => {
    let best: OcrWord | null = null;
    let bestScore = 0;
    for (const candidate of usable) {
      const score = tokenScore(expected, candidate.normalized);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      } else if (score === bestScore && best && candidate.normalized.length < best.normalized.length) {
        best = candidate;
      }
    }
    const status: TokenStatus =
      bestScore >= threshold ? 'match' : bestScore >= nearRatio(threshold) ? 'near' : 'missing';
    return {
      expected,
      matched: best ? best.text : null,
      similarity: best ? bestScore : 0,
      status,
      bbox: best ? best.bbox : null,
      confidence: best ? best.confidence : null,
    };
  });
}

export function nearRatio(threshold: number): number {
  return Math.max(0.5, threshold * 0.72);
}

export function classifyMatch(match: TokenMatch, threshold: number, legible: boolean): TokenStatus {
  if (!legible) return 'unreadable';
  if (match.similarity >= threshold) return 'match';
  if (match.similarity >= nearRatio(threshold)) return 'near';
  return 'missing';
}

export interface Legibility {
  legible: boolean;
  meanConfidence: number;
  charCount: number;
  wordCount: number;
}

export function assessLegibility(words: OcrWord[], minWordConfidence: number): Legibility {
  const kept = words.filter((word) => word.confidence >= minWordConfidence && word.normalized.length > 0);
  const charCount = kept.reduce((total, word) => total + word.normalized.replace(/\s/g, '').length, 0);
  const meanConfidence =
    kept.length > 0 ? kept.reduce((total, word) => total + word.confidence, 0) / kept.length : 0;
  return {
    legible: kept.length >= 1 && charCount >= 4 && meanConfidence >= 35,
    meanConfidence: Math.round(meanConfidence * 10) / 10,
    charCount,
    wordCount: kept.length,
  };
}

export interface TextLine {
  text: string;
  confidence: number;
}

/** Group OCR words into visual lines for the reference-photo text scanner. */
export function groupLines(words: OcrWord[]): TextLine[] {
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const lines: OcrWord[][] = [];

  for (const word of sorted) {
    const line = lines.find((candidate) => {
      const first = candidate[0];
      const overlap = Math.min(first.bbox.y1, word.bbox.y1) - Math.max(first.bbox.y0, word.bbox.y0);
      const smallestHeight = Math.min(
        first.bbox.y1 - first.bbox.y0,
        word.bbox.y1 - word.bbox.y0,
      );
      return overlap > smallestHeight * 0.5;
    });
    if (line) line.push(word);
    else lines.push([word]);
  }

  return lines
    .map((line) => {
      const ordered = [...line].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      return {
        text: ordered.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim(),
        confidence: Math.round(ordered.reduce((total, word) => total + word.confidence, 0) / ordered.length),
      };
    })
    .filter((line) => line.text.length > 0);
}

export function thresholdFor(strictness: Strictness): number {
  switch (strictness) {
    case 'strict':
      return 0.95;
    case 'lenient':
      return 0.75;
    case 'balanced':
    default:
      return 0.87;
  }
}

export function minConfidenceFor(strictness: Strictness): number {
  switch (strictness) {
    case 'strict':
      return 60;
    case 'lenient':
      return 30;
    case 'balanced':
    default:
      return 45;
  }
}

export function formatPercent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}
