export type SceneId = 'luxury-studio' | 'sunset-outdoors' | 'neon-city';

export type Strictness = 'strict' | 'balanced' | 'lenient';

export type Verdict = 'PASS' | 'REVIEW' | 'FAIL';

export type CheckStatus = 'pass' | 'review' | 'fail' | 'skipped';

export type TokenStatus = 'match' | 'near' | 'missing' | 'unreadable';

/** How a whole token behaved across the sampled frames, after all OCR passes. */
export type TokenFinding =
  | 'verified'
  | 'detected'
  | 'visibly-distorted'
  | 'not-detected'
  | 'unreadable'
  | 'insufficient-evidence';

export type OcrVariant = 'original' | 'grayscale' | 'contrast' | 'threshold' | 'threshold-inverted';

export type OcrRegionSource = 'manual' | 'auto' | 'full-frame';

export interface OcrPassInfo {
  id: string;
  label: string;
  psm: number;
  variant: OcrVariant;
  wordCount: number;
  confidence: number;
  error?: string;
}

export type FrameStatus = 'pass' | 'review' | 'fail' | 'unreadable';

export type ClipSource = 'cloud' | 'local' | 'import';

export type VideoSource = 'imported' | 'generated' | 'cloud';

export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Rectangle in normalized 0..1 image coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrWord {
  text: string;
  normalized: string;
  confidence: number;
  bbox: Bbox;
}

export interface TokenMatch {
  expected: string;
  matched: string | null;
  similarity: number;
  status: TokenStatus;
  bbox: Bbox | null;
  confidence: number | null;
}

export interface FrameSample {
  index: number;
  time: number;
  dataUrl: string;
  width: number;
  height: number;
  paletteSimilarity: number | null;
  words: OcrWord[];
  text: string;
  meanConfidence: number;
  legible: boolean;
  brand: TokenMatch[];
  label: TokenMatch[];
  status: FrameStatus;
  notes: string[];
  ocrPasses?: OcrPassInfo[];
  ocrRegion?: Rect | null;
  ocrRegionSource?: OcrRegionSource;
}

export interface VerifyConfig {
  brand: string;
  labelText: string;
  scene: SceneId;
  strictness: Strictness;
  coverage: number;
  sampleCount: number;
  labelCritical: boolean;
  region: Rect | null;
}

export interface ReportConfig extends VerifyConfig {
  threshold: number;
  minWordConfidence: number;
  brandTokens: string[];
  labelTokens: string[];
}

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  critical: boolean;
  detail: string;
  metric: string;
}

export interface ReportMetrics {
  sampledFrames: number;
  readableFrames: number;
  requiredReadableFrames: number;
  brandHits: number;
  brandRecall: number;
  labelHits: number | null;
  labelRecall: number | null;
  meanConfidence: number;
  readableFraction: number;
  paletteSimilarity: number | null;
  coverageTarget: number;
}

export interface TokenEvidence {
  token: string;
  kind: 'brand' | 'label';
  hits: number;
  near: number;
  missing: number;
  unreadable: number;
  bestReading: string | null;
  bestSimilarity: number;
  bestConfidence: number | null;
  finding: TokenFinding;
}

export interface ReportDiagnostics {
  capture: {
    width: number;
    height: number;
    requestedFrames: number;
    capturedFrames: number;
  };
  ocr: {
    engine: string;
    passesPerFrame: number[];
    totalPasses: number;
    totalWords: number;
    regionSources: OcrRegionSource[];
  };
}

export interface VerificationReport {
  app: 'BrandProof';
  schemaVersion: string;
  createdAt: string;
  verdict: Verdict;
  headline: string;
  summary: string;
  config: ReportConfig;
  video: {
    name: string;
    source: VideoSource;
    duration: number;
  };
  checks: CheckResult[];
  metrics: ReportMetrics;
  tokenEvidence: TokenEvidence[];
  frames: FrameSample[];
  limitations: string[];
  diagnostics?: ReportDiagnostics;
}

export interface ReferenceAsset {
  file: File;
  url: string;
  image: HTMLImageElement;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  name: string;
  paletteBins: number[];
  swatches: string[];
}

export interface VideoAsset {
  url: string;
  name: string;
  source: VideoSource;
  duration: number;
  size: number;
  width: number;
  height: number;
}

export interface AnalysisState {
  status: 'idle' | 'running' | 'done' | 'error';
  stage?: 'sample' | 'ocr' | 'compare' | 'report';
  message?: string;
  progress: number;
  frameIndex?: number;
  frameCount?: number;
  report?: VerificationReport;
  error?: string;
}
