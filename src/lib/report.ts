import type { VerificationReport } from '../types';

/** Report JSON intentionally excludes frame images so the file stays small and portable. */
export function reportToJson(report: VerificationReport): string {
  const serialisable = {
    ...report,
    frames: report.frames.map((frame) => ({
      index: frame.index,
      time: frame.time,
      width: frame.width,
      height: frame.height,
      paletteSimilarity: frame.paletteSimilarity,
      legible: frame.legible,
      meanConfidence: frame.meanConfidence,
      status: frame.status,
      text: frame.text,
      notes: frame.notes,
      brand: frame.brand,
      label: frame.label,
      words: frame.words,
    })),
  };
  return `${JSON.stringify(serialisable, null, 2)}\n`;
}

export function downloadText(filename: string, contents: string, mime = 'application/json'): void {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function reportFilename(report: VerificationReport): string {
  const brand = report.config.brand
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const stamp = report.createdAt.replace(/[:.]/g, '-');
  return `brandproof-${brand || 'report'}-${stamp}.json`;
}

export function downloadReport(report: VerificationReport): void {
  downloadText(reportFilename(report), reportToJson(report));
}
