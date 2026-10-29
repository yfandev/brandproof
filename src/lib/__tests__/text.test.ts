import { describe, expect, it } from 'vitest';
import {
  assessLegibility,
  buildCandidates,
  buildExpectedTokens,
  groupLines,
  matchTokens,
  normalizeText,
  similarity,
  tokenScore,
} from '../text';
import type { OcrWord } from '../../types';

function word(text: string, x: number, y: number, confidence = 92): OcrWord {
  return {
    text,
    normalized: normalizeText(text),
    confidence,
    bbox: { x0: x / 100, y0: y / 100, x1: (x + 30) / 100, y1: (y + 12) / 100 },
  };
}

describe('normalizeText', () => {
  it('lowercases, strips diacritics and punctuation', () => {
    expect(normalizeText('Lumière & Co.')).toBe('lumiere co');
    expect(normalizeText('30 ml / 1.0 FL OZ')).toBe('30 ml 1 0 fl oz');
    expect(normalizeText('   ')).toBe('');
  });

  it('treats typographic dashes and quotes as separators', () => {
    expect(normalizeText('“AURELIA”—30ml')).toBe('aurelia 30ml');
  });
});

describe('expected tokens', () => {
  it('does not count brand words twice in the label text', () => {
    const { brandTokens, labelTokens } = buildExpectedTokens('Aurelia', 'Aurelia Renewal Serum');
    expect(brandTokens).toEqual(['aurelia']);
    expect(labelTokens).toEqual(['renewal', 'serum']);
  });

  it('splits label text into ordered unique tokens', () => {
    const { labelTokens } = buildExpectedTokens('Aurelia', '30 ml\n30 ml / 1.0 fl oz');
    expect(labelTokens).toEqual(['30', 'ml', '1', '0', 'fl', 'oz']);
  });
});

describe('similarity', () => {
  it('scores OCR-style substitutions', () => {
    expect(similarity('aurelia', 'aurelia')).toBe(1);
    expect(similarity('aurelia', 'aurelja')).toBeCloseTo(6 / 7, 5);
    expect(similarity('aurelia', 'botanica')).toBeLessThan(0.5);
  });

  it('scores containment below an exact match', () => {
    expect(tokenScore('aurelia', 'aureliaserum')).toBeCloseTo(0.91, 5);
    expect(tokenScore('aurelia', 'aurelia')).toBe(1);
  });
});

describe('OCR candidates', () => {
  it('joins adjacent words and splits alphanumeric tokens', () => {
    const candidates = buildCandidates([word('AURELIA', 10, 10), word('30ML', 50, 10)]).map(
      (candidate) => candidate.normalized,
    );
    expect(candidates).toContain('aurelia30ml');
    expect(candidates).toContain('30');
    expect(candidates).toContain('ml');
  });

  it('matches a brand that OCR merged with the following word', () => {
    const candidates = buildCandidates([word('AURELIA', 10, 10), word('SERUM', 50, 10)]);
    const matches = matchTokens(['aurelia', 'serum'], candidates, 0.87, 45);
    expect(matches.every((match) => match.similarity >= 0.87)).toBe(true);
  });

  it('does not join words on different lines', () => {
    const candidates = buildCandidates([word('AURELIA', 10, 10), word('SERUM', 50, 70)]);
    expect(candidates.map((candidate) => candidate.normalized)).not.toContain('aurelias erum');
  });

  it('respects minimum word confidence', () => {
    const candidates = buildCandidates([word('AURELIA', 10, 10, 20)]);
    const [match] = matchTokens(['aurelia'], candidates, 0.87, 45);
    expect(match.similarity).toBe(0);
    expect(match.matched).toBeNull();
  });
});

describe('legibility', () => {
  it('requires enough characters and confidence', () => {
    expect(assessLegibility([word('AURELIA', 10, 10)], 45).legible).toBe(true);
    expect(assessLegibility([word('AB', 10, 10)], 45).legible).toBe(false);
    expect(assessLegibility([word('AURELIA', 10, 10, 10)], 45).legible).toBe(false);
    expect(assessLegibility([], 45).legible).toBe(false);
  });
});

describe('groupLines', () => {
  it('groups words by visual line and sorts left to right', () => {
    const lines = groupLines([word('SERUM', 60, 30), word('AURELIA', 10, 30), word('30', 10, 70)]);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('AURELIA SERUM');
    expect(lines[1].text).toBe('30');
  });
});
