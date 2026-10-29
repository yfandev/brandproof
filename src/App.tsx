import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalysisState,
  Rect,
  ReferenceAsset,
  SceneId,
  Strictness,
  VerificationReport,
  VerifyConfig,
  VideoAsset,
} from './types';
import { analyzeVideo, disposeOcr } from './lib/analyze';
import { loadReferenceImage } from './lib/image';
import { groupLines } from './lib/text';
import { recognizeCanvas } from './lib/ocr';
import { probeVideo, describeUnsupportedFile } from './lib/video';
import { buildPrompt, sceneById } from './lib/scenes';
import { ProductPanel, type ScanState } from './components/ProductPanel';
import { BriefPanel } from './components/BriefPanel';
import { VideoPanel } from './components/VideoPanel';
import { VerifyPanel } from './components/VerifyPanel';
import { Pill } from './components/ui';

const DEFAULT_SCENE: SceneId = 'luxury-studio';

function Logo() {
  return (
    <svg viewBox="0 0 44 44" width="34" height="34" fill="none" aria-hidden="true">
      <rect width="44" height="44" rx="12" fill="#101216" stroke="rgba(255,255,255,0.08)" />
      <path d="M14 12h-3v20h3M30 12h3v20h-3" stroke="#d7ff5f" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="22" cy="19" r="3.6" fill="#d7ff5f" />
      <path d="M16.5 28h11" stroke="#f2f3f5" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const [product, setProduct] = useState<ReferenceAsset | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [productBusy, setProductBusy] = useState(false);
  const [region, setRegion] = useState<Rect | null>(null);
  const [scan, setScan] = useState<ScanState>({ status: 'idle' });

  const [brand, setBrand] = useState('');
  const [labelText, setLabelText] = useState('');
  const [scene, setScene] = useState<SceneId>(DEFAULT_SCENE);
  const [prompt, setPrompt] = useState(() => buildPrompt(DEFAULT_SCENE, '', ''));
  const [promptDirty, setPromptDirty] = useState(false);

  const [strictness, setStrictness] = useState<Strictness>('balanced');
  const [coverage, setCoverage] = useState(0.6);
  const [sampleCount, setSampleCount] = useState(9);
  const [labelCritical, setLabelCritical] = useState(true);

  const [source, setSource] = useState<'generate' | 'import'>('import');
  const [video, setVideo] = useState<VideoAsset | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle', progress: 0 });

  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!promptDirty) setPrompt(buildPrompt(scene, brand, labelText));
  }, [scene, brand, labelText, promptDirty]);

  useEffect(() => {
    if (!product) return undefined;
    return () => URL.revokeObjectURL(product.url);
  }, [product]);

  useEffect(() => {
    if (!video) return undefined;
    return () => URL.revokeObjectURL(video.url);
  }, [video]);

  useEffect(() => () => void disposeOcr(), []);

  const handleProductSelect = async (file: File) => {
    setProductError(null);
    setProductBusy(true);
    try {
      const loaded = await loadReferenceImage(file);
      setProduct({ file, name: file.name, ...loaded });
      setScan({ status: 'idle' });
      setAnalysis({ status: 'idle', progress: 0 });
    } catch (error) {
      setProductError(error instanceof Error ? error.message : 'The image could not be loaded.');
    } finally {
      setProductBusy(false);
    }
  };

  const handleClearProduct = () => {
    setProduct(null);
    setRegion(null);
    setScan({ status: 'idle' });
    setAnalysis({ status: 'idle', progress: 0 });
  };

  const handleScanReference = async () => {
    if (!product) return;
    setScan({ status: 'running' });
    try {
      const result = await recognizeCanvas(product.canvas, { region });
      const lines = groupLines(result.words)
        .filter((line) => line.text.replace(/[^a-zA-Z0-9]/g, '').length >= 2)
        .slice(0, 12);
      setScan({
        status: 'done',
        lines: lines.map((line) => ({ text: line.text, confidence: line.confidence })),
      });
    } catch (error) {
      setScan({
        status: 'error',
        error: error instanceof Error ? error.message : 'OCR failed on the reference photo.',
      });
    }
  };

  const handleUseLine = (text: string, target: 'label' | 'brand') => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (target === 'brand') {
      setBrand(clean);
      return;
    }
    setLabelText((previous) => {
      if (!previous.trim()) return clean;
      if (previous.includes(clean)) return previous;
      return `${previous.trimEnd()}\n${clean}`;
    });
  };

  const handleImport = async (file: File) => {
    setVideoError(null);
    const rejection = describeUnsupportedFile(file);
    if (rejection) {
      setVideoError(rejection);
      return;
    }
    setImporting(true);
    const url = URL.createObjectURL(file);
    try {
      const probe = await probeVideo(url, file);
      setVideo({
        url,
        name: file.name,
        source: 'imported',
        duration: probe.duration,
        size: file.size,
        width: probe.width,
        height: probe.height,
      });
      setAnalysis({ status: 'idle', progress: 0 });
    } catch (error) {
      URL.revokeObjectURL(url);
      setVideoError(error instanceof Error ? error.message : 'This clip could not be read.');
    } finally {
      setImporting(false);
    }
  };

  const handleGenerated = async (blob: Blob, filename: string) => {
    setVideoError(null);
    const url = URL.createObjectURL(blob);
    const file = new File([blob], filename || 'comfy-clip.mp4', {
      type: blob.type || 'video/mp4',
    });
    try {
      const probe = await probeVideo(url, file);
      setVideo({
        url,
        name: filename || 'comfy-clip.mp4',
        source: 'generated',
        duration: probe.duration,
        size: blob.size,
        width: probe.width,
        height: probe.height,
      });
      setAnalysis({ status: 'idle', progress: 0 });
    } catch (error) {
      URL.revokeObjectURL(url);
      setVideoError(
        `ComfyUI produced a file this browser cannot decode. Export an MP4 (H.264) from your workflow. ${
          error instanceof Error ? error.message : ''
        }`.trim(),
      );
    }
  };

  const runVerification = async (regionOverride?: Rect | null) => {
    const element = videoRef.current;
    if (!video || !element) {
      setVideoError('Load or generate a clip before verifying.');
      return;
    }
    if (!brand.trim()) return;

    const activeRegion = regionOverride === undefined ? region : regionOverride;
    const config: VerifyConfig = {
      brand,
      labelText,
      scene,
      strictness,
      coverage,
      sampleCount,
      labelCritical,
      region: activeRegion,
    };

    setAnalysis({ status: 'running', progress: 0, stage: 'sample', message: 'Starting analysis' });
    try {
      const report = await analyzeVideo({
        video: element,
        config,
        reference: product ? { canvas: product.canvas } : null,
        videoMeta: { name: video.name, source: video.source, duration: video.duration },
        onProgress: (progress) => {
          setAnalysis((previous) =>
            previous.status === 'running'
              ? {
                  status: 'running',
                  progress: progress.progress,
                  stage: progress.stage,
                  message: progress.message,
                  frameIndex: progress.frameIndex,
                  frameCount: progress.frameCount,
                }
              : previous,
          );
        },
      });
      setAnalysis({ status: 'done', progress: 1, report });
    } catch (error) {
      setAnalysis({
        status: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : 'Verification failed unexpectedly.',
      });
    }
  };

  const handleRerunWithRegion = (rect: Rect) => {
    setRegion(rect);
    void runVerification(rect);
  };

  const report: VerificationReport | null = analysis.report ?? null;

  const missing = useMemo(() => {
    const items: string[] = [];
    if (!video) items.push('a clip');
    if (!brand.trim()) items.push('a brand name');
    return items;
  }, [video, brand]);

  const stale = useMemo(() => {
    if (!report) return false;
    const cfg = report.config;
    return (
      cfg.brand !== brand ||
      cfg.labelText !== labelText ||
      cfg.scene !== scene ||
      cfg.strictness !== strictness ||
      cfg.coverage !== coverage ||
      cfg.sampleCount !== sampleCount ||
      cfg.labelCritical !== labelCritical ||
      JSON.stringify(cfg.region) !== JSON.stringify(region) ||
      report.video.name !== video?.name ||
      Math.abs((report.video.duration ?? 0) - (video?.duration ?? 0)) > 0.5
    );
  }, [report, brand, labelText, scene, strictness, coverage, sampleCount, labelCritical, region, video]);

  const reset = () => {
    setProduct(null);
    setProductError(null);
    setProductBusy(false);
    setRegion(null);
    setScan({ status: 'idle' });
    setBrand('');
    setLabelText('');
    setScene(DEFAULT_SCENE);
    setPrompt(buildPrompt(DEFAULT_SCENE, '', ''));
    setPromptDirty(false);
    setStrictness('balanced');
    setCoverage(0.6);
    setSampleCount(9);
    setLabelCritical(true);
    setSource('import');
    setVideo(null);
    setVideoError(null);
    setAnalysis({ status: 'idle', progress: 0 });
  };

  const activeScene = sceneById(scene);
  const steps = [
    { title: 'Source', detail: 'Pack shot + brand text', done: Boolean(product) && brand.trim().length > 0 },
    { title: 'Clip', detail: activeScene.name, done: Boolean(video) },
    { title: 'Report', detail: 'OCR evidence + JSON', done: Boolean(report) },
  ];

  return (
    <div className="app">
      <div className="backdrop" aria-hidden="true" />

      <header className="topbar">
        <div className="topbar__brand">
          <Logo />
          <div className="topbar__text">
            <span className="topbar__name">BrandProof</span>
            <span className="topbar__tag">visual fidelity verifier</span>
          </div>
        </div>
        <div className="topbar__right">
          <span className="hackbadge">Comfy OSS × Higgsfield</span>
          <button type="button" className="btn btn--subtle btn--sm" onClick={reset}>
            Reset session
          </button>
        </div>
      </header>

      <main className="main">
        <section className="hero">
          <div className="hero__copy">
            <p className="eyebrow">
              <span className="live-dot" aria-hidden="true" /> Hackathon build · browser OCR · no keys
            </p>
            <h1>
              Prove the product
              <br />
              <span>survived the render.</span>
            </h1>
            <p className="hero__lede">
              Upload the pack shot, generate or import an AI ad, then let Tesseract read the label in sampled frames.
              You get word-level boxes, a PASS / REVIEW / FAIL verdict and a JSON report you can defend.
            </p>
          </div>
          <ol className="steps" aria-label="Workflow progress">
            {steps.map((step, index) => (
              <li key={step.title} className={`step ${step.done ? 'step--done' : ''}`}>
                <span className="step__index">{String(index + 1).padStart(2, '0')}</span>
                <span className="step__body">
                  <strong>{step.title}</strong>
                  <em>{step.detail}</em>
                </span>
                <span className="step__state" aria-hidden="true">
                  {step.done ? '✓' : '·'}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <div className="layout layout--brief">
          <ProductPanel
            product={product}
            error={productError}
            busy={productBusy}
            region={region}
            scan={scan}
            onSelect={(file) => void handleProductSelect(file)}
            onClearProduct={handleClearProduct}
            onClearError={() => setProductError(null)}
            onRegionChange={setRegion}
            onScan={() => void handleScanReference()}
            onUseLine={handleUseLine}
          />

          <BriefPanel
            brand={brand}
            labelText={labelText}
            scene={scene}
            prompt={prompt}
            promptDirty={promptDirty}
            onBrandChange={(value) => setBrand(value)}
            onLabelChange={(value) => setLabelText(value)}
            onSceneChange={(value) => setScene(value)}
            onPromptChange={(value) => {
              setPrompt(value);
              setPromptDirty(true);
            }}
            onResetPrompt={() => {
              setPrompt(buildPrompt(scene, brand, labelText));
              setPromptDirty(false);
            }}
          />
        </div>

        <VideoPanel
          source={source}
          onSourceChange={setSource}
          video={video}
          videoRef={videoRef}
          error={videoError}
          importing={importing}
          product={product}
          prompt={prompt}
          onImport={(file) => void handleImport(file)}
          onClearVideo={() => {
            setVideo(null);
            setAnalysis({ status: 'idle', progress: 0 });
          }}
          onClearError={() => setVideoError(null)}
          onGenerated={(blob, filename) => void handleGenerated(blob, filename)}
          onDurationChange={(duration) => {
            setVideo((previous) =>
              previous && Math.abs(previous.duration - duration) > 0.05 ? { ...previous, duration } : previous,
            );
          }}
        />

        <VerifyPanel
          brand={brand}
          strictness={strictness}
          coverage={coverage}
          sampleCount={sampleCount}
          labelCritical={labelCritical}
          hasVideo={Boolean(video)}
          hasProduct={Boolean(product)}
          analysis={analysis}
          missing={missing}
          stale={stale}
          report={report}
          reference={product}
          region={region}
          onStrictnessChange={setStrictness}
          onCoverageChange={setCoverage}
          onSampleCountChange={setSampleCount}
          onLabelCriticalChange={setLabelCritical}
          onRun={() => void runVerification()}
          onRerunWithRegion={handleRerunWithRegion}
          onClearRegion={() => setRegion(null)}
        />

        <footer className="footer">
          <div className="footer__brand">
            <p className="footer__mark">BrandProof</p>
            <p className="micro">
              Automated label-consistency verification for AI product ads. Built for the Comfy Open Source × Higgsfield
              hackathon.
            </p>
          </div>
          <div className="footer__meta">
            <Pill tone="neutral">Tesseract.js OCR</Pill>
            <Pill tone="neutral">ComfyUI API</Pill>
            <Pill tone="neutral">MIT licensed</Pill>
          </div>
          <p className="micro footer__note">
            Every clip, photo and OCR result is processed locally in this tab, except a ComfyUI generation you trigger
            yourself. Verdicts are evidence, not a guarantee.
          </p>
        </footer>
      </main>
    </div>
  );
}
