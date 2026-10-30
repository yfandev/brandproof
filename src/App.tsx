import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalysisState,
  ClipSource,
  Rect,
  ReferenceAsset,
  SceneId,
  Strictness,
  VerificationReport,
  VerifyConfig,
  VideoAsset,
  VideoSource,
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
import { CatalogPanel } from './components/CatalogPanel';
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
  const [mode, setMode] = useState<'studio' | 'catalog'>('catalog');
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
  const [sampleCount, setSampleCount] = useState(12);
  const [labelCritical, setLabelCritical] = useState(true);

  const [source, setSource] = useState<ClipSource>('cloud');
  const [video, setVideo] = useState<VideoAsset | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle', progress: 0 });
  const [autoVerify, setAutoVerify] = useState(false);

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

  const handleImport = async (file: File, origin: 'imported' | 'cloud' = 'imported') => {
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
        source: origin,
        duration: probe.duration,
        size: file.size,
        width: probe.width,
        height: probe.height,
      });
      setAnalysis({ status: 'idle', progress: 0 });
      setAutoVerify(Boolean(brand.trim()));
    } catch (error) {
      URL.revokeObjectURL(url);
      setVideoError(error instanceof Error ? error.message : 'This clip could not be read.');
    } finally {
      setImporting(false);
    }
  };

  const handleGenerated = async (
    blob: Blob,
    filename: string,
    origin: VideoSource = 'generated',
  ) => {
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
        source: origin,
        duration: probe.duration,
        size: blob.size,
        width: probe.width,
        height: probe.height,
      });
      setAnalysis({ status: 'idle', progress: 0 });
      setAutoVerify(Boolean(brand.trim()));
    } catch (error) {
      URL.revokeObjectURL(url);
      setVideoError(
        `${origin === 'cloud' ? 'Comfy Cloud' : 'ComfyUI'} produced a file this browser cannot decode. Export an MP4 (H.264) from your workflow. ${
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

  // Auto-verify the actual returned/generated MP4 once its player is ready.
  useEffect(() => {
    if (!autoVerify || !video) return undefined;
    const element = videoRef.current;
    if (!element) return undefined;

    let cancelled = false;
    const trigger = () => {
      if (cancelled) return;
      setAutoVerify(false);
      void runVerification();
    };

    if (element.readyState >= 1) {
      const timer = window.setTimeout(trigger, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    element.addEventListener('loadedmetadata', trigger, { once: true });
    return () => {
      cancelled = true;
      element.removeEventListener('loadedmetadata', trigger);
    };
  }, [autoVerify, video]);

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

  // The catalog tab keeps its own run and snapshot, so it has its own reset.
  const [catalogResetToken, setCatalogResetToken] = useState(0);
  const [catalogBusy, setCatalogBusy] = useState(false);

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
    setSampleCount(12);
    setLabelCritical(true);
    setSource('cloud');
    setAutoVerify(false);
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
          <div className="modeswitch" role="group" aria-label="BrandProof mode">
            <button
              type="button"
              className={`modeswitch__btn ${mode === 'studio' ? 'modeswitch__btn--active' : ''}`}
              aria-pressed={mode === 'studio'}
              onClick={() => setMode('studio')}
            >
              Studio
            </button>
            <button
              type="button"
              className={`modeswitch__btn ${mode === 'catalog' ? 'modeswitch__btn--active' : ''}`}
              aria-pressed={mode === 'catalog'}
              onClick={() => setMode('catalog')}
            >
              Catalog pilot
            </button>
          </div>
          <span className="hackbadge">Comfy open-source build</span>
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            onClick={mode === 'studio' ? reset : () => setCatalogResetToken((token) => token + 1)}
            disabled={mode === 'catalog' && catalogBusy}
            title={
              mode === 'catalog' && catalogBusy
                ? 'A catalog run is in progress. Reset is available once it finishes.'
                : mode === 'catalog'
                  ? 'Clear the catalog drafts, run and saved snapshot in this browser.'
                  : 'Clear the studio session in this browser.'
            }
          >
            Reset session
          </button>
        </div>
      </header>

      <main className="main">
        {mode === 'studio' ? (
          <>
        <div className="award">
          <span className="award__badge">🏆 Award winner</span>
          <span className="award__text">
            <strong>Won Comfy Build Nights — San Francisco, 28 October 2026.</strong> This Studio tab is the build
            that was demoed on stage: one product, one clip, one verdict you can defend.
          </span>
        </div>
        <section className="hero">
          <div className="hero__copy">
            <p className="eyebrow">
              <span className="live-dot" aria-hidden="true" /> Hackathon build · browser OCR · key stays server-side
            </p>
            <h1>
              Prove the product
              <br />
              <span>survived the render.</span>
            </h1>
            <p className="hero__lede">
              Upload the pack shot, set the exact label, and generate with the bundled LTX-2.3 workflow on Comfy Cloud.
              BrandProof pulls the returned MP4 back automatically, then Tesseract reads the label in sampled frames,
              with word-level boxes, a PASS / REVIEW / FAIL verdict and a JSON report you can defend.
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
          brand={brand}
          onImport={(file) => void handleImport(file)}
          onCloudImport={(file) => void handleImport(file, 'cloud')}
          onCloudGenerated={(blob, filename) => void handleGenerated(blob, filename, 'cloud')}
          onClearVideo={() => {
            setVideo(null);
            setAutoVerify(false);
            setAnalysis({ status: 'idle', progress: 0 });
          }}
          onClearError={() => setVideoError(null)}
          onGenerated={(blob, filename) => void handleGenerated(blob, filename, 'generated')}
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

          </>
        ) : (
          <CatalogPanel resetToken={catalogResetToken} onBusyChange={setCatalogBusy} />
        )}

        <footer className="footer">
          <div className="footer__brand">
            <p className="footer__mark">BrandProof</p>
            <p className="micro">
              Automated label-consistency verification for AI product ads. An open-source build on the Comfy developer
              platform.
            </p>
          </div>
          <div className="footer__meta">
            <Pill tone="neutral">Tesseract.js OCR</Pill>
            <Pill tone="neutral">Comfy Cloud API v2</Pill>
            <Pill tone="neutral">MIT licensed</Pill>
          </div>
          <p className="micro footer__note">
            Photos, clips, frames and OCR stay in this tab. Comfy Cloud generation runs through BrandProof&apos;s
            server-side proxy with the key held in the Worker. Verdicts are evidence, not a guarantee.
          </p>
        </footer>
      </main>
    </div>
  );
}
