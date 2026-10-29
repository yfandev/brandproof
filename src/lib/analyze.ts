import type { Rect, VerificationReport, VideoSource } from '../types';
import { paletteFromCanvas, comparePalettes, cropNormalized } from './image';
import { captureFrames } from './frames';
import { disposeOcr, OcrError, recognizeCanvas } from './ocr';
import { buildReport, evaluateFrame, reportInputs } from './verdict';

export interface AnalyzeProgress {
  stage: 'sample' | 'ocr' | 'compare' | 'report';
  message: string;
  progress: number;
  frameIndex?: number;
  frameCount?: number;
}

export class AnalysisError extends Error {}

export interface AnalyzeOptions {
  video: HTMLVideoElement;
  config: import('../types').VerifyConfig;
  reference: { canvas: HTMLCanvasElement } | null;
  videoMeta: { name: string; source: VideoSource; duration: number };
  onProgress?: (progress: AnalyzeProgress) => void;
}

export async function analyzeVideo(options: AnalyzeOptions): Promise<VerificationReport> {
  const { video, config, reference, videoMeta, onProgress } = options;

  if (!config.brand.trim()) {
    throw new AnalysisError('Enter the exact brand name that must be preserved before verifying.');
  }
  if (!Number.isFinite(video.duration) || video.duration <= 0.1) {
    throw new AnalysisError('The loaded clip has no usable duration. Import a video longer than 0.2 seconds.');
  }

  const reportConfig = reportInputs(config);
  const total = config.sampleCount;

  onProgress?.({ stage: 'sample', message: 'Sampling frames across the clip', progress: 0 });

  let frames;
  try {
    frames = await captureFrames(video, config.sampleCount, (done, count) => {
      onProgress?.({
        stage: 'sample',
        message: `Sampling frame ${done} of ${count}`,
        progress: done / count,
      });
    });
  } catch (error) {
    throw new AnalysisError(error instanceof Error ? error.message : 'Frame sampling failed.');
  }

  const region: Rect | null = config.region;
  const referencePalette = reference
    ? paletteFromCanvas(
        region ? cropNormalized(reference.canvas, region) : reference.canvas,
      ).bins
    : null;

  const frameSamples = [];
  try {
    for (const frame of frames) {
      const index = frame.index;
      onProgress?.({
        stage: 'ocr',
        message: `Reading label text · frame ${index + 1} of ${frames.length}`,
        progress: index / frames.length,
        frameIndex: index,
        frameCount: frames.length,
      });

      const ocr = await recognizeCanvas(frame.canvas, {
        region,
        autoRegion: true,
        focusTokens: reportConfig.brandTokens,
        onProgress: (value) => {
          onProgress?.({
            stage: 'ocr',
            message: `Reading label text · frame ${index + 1} of ${frames.length}`,
            progress: (index + value) / frames.length,
            frameIndex: index,
            frameCount: frames.length,
          });
        },
        onEngineStatus: (status) => {
          onProgress?.({
            stage: 'ocr',
            message: status,
            progress: 0,
            frameIndex: index,
            frameCount: frames.length,
          });
        },
      });

      onProgress?.({
        stage: 'compare',
        message: `Comparing frame ${index + 1} of ${frames.length}`,
        progress: (index + 0.85) / frames.length,
        frameIndex: index,
        frameCount: frames.length,
      });

      const frameCanvas = region ? cropNormalized(frame.canvas, region) : frame.canvas;
      const paletteSimilarity = referencePalette
        ? comparePalettes(referencePalette, paletteFromCanvas(frameCanvas).bins)
        : null;

      const sample = evaluateFrame({
        index,
        time: frame.time,
        dataUrl: frame.dataUrl,
        width: frame.width,
        height: frame.height,
        paletteSimilarity,
        rawWords: ocr.words,
        text: ocr.text,
        config,
        threshold: reportConfig.threshold,
        minWordConfidence: reportConfig.minWordConfidence,
        brandTokens: reportConfig.brandTokens,
        labelTokens: reportConfig.labelTokens,
        region,
        ocrPasses: ocr.passes,
        ocrRegion: ocr.region,
        ocrRegionSource: ocr.regionSource,
      });
      frameSamples.push(sample);
    }
  } catch (error) {
    if (error instanceof OcrError) throw new AnalysisError(error.message);
    throw new AnalysisError(error instanceof Error ? error.message : 'OCR failed.');
  }

  onProgress?.({ stage: 'report', message: 'Building the evidence report', progress: 0.97 });

  const paletteValues = frameSamples
    .map((frame) => frame.paletteSimilarity)
    .filter((value): value is number => typeof value === 'number');
  const referenceSimilarity =
    paletteValues.length > 0
      ? paletteValues.reduce((totalValue, value) => totalValue + value, 0) / paletteValues.length
      : null;

  const report = buildReport({
    config,
    frames: frameSamples,
    video: videoMeta,
    brandTokens: reportConfig.brandTokens,
    labelTokens: reportConfig.labelTokens,
    threshold: reportConfig.threshold,
    minWordConfidence: reportConfig.minWordConfidence,
    referenceSimilarity,
  });

  const passesPerFrame = frameSamples.map((frame) => frame.ocrPasses?.length ?? 0);
  const regionSources = Array.from(
    new Set(frameSamples.map((frame) => frame.ocrRegionSource ?? 'full-frame')),
  );
  report.diagnostics = {
    capture: {
      width: frames[0]?.width ?? 0,
      height: frames[0]?.height ?? 0,
      requestedFrames: total,
      capturedFrames: frames.length,
    },
    ocr: {
      engine: 'Tesseract.js 7 (LSTM)',
      passesPerFrame,
      totalPasses: passesPerFrame.reduce((sum, count) => sum + count, 0),
      totalWords: frameSamples.reduce((sum, frame) => sum + frame.words.length, 0),
      regionSources,
    },
  };

  if (report.frames.length !== total) {
    // Defensive: sampling always returns the requested count, but keep the report honest.
    report.limitations.push(
      `Requested ${total} frames; ${report.frames.length} were captured with this browser.`,
    );
  }

  onProgress?.({ stage: 'report', message: 'Report ready', progress: 1 });
  return report;
}

export { disposeOcr };
