import { useEffect, useRef } from 'react';
import type { AnalysisState, Rect, VerificationReport, VerifyConfig } from '../types';
import { thresholdFor } from '../lib/text';
import { EvidenceReport } from './EvidenceReport';
import { Alert, Card, Pill, statusTone } from './ui';

interface VerifyPanelProps {
  brand: string;
  strictness: VerifyConfig['strictness'];
  coverage: number;
  sampleCount: number;
  labelCritical: boolean;
  hasVideo: boolean;
  hasProduct: boolean;
  analysis: AnalysisState;
  missing: string[];
  stale: boolean;
  report: VerificationReport | null;
  region: Rect | null;
  onStrictnessChange: (value: VerifyConfig['strictness']) => void;
  onCoverageChange: (value: number) => void;
  onSampleCountChange: (value: number) => void;
  onLabelCriticalChange: (value: boolean) => void;
  onRun: () => void;
  onRerunWithRegion: (rect: Rect) => void;
  onClearRegion: () => void;
  reference: import('../types').ReferenceAsset | null;
}

const STEPS: Array<{ id: NonNullable<AnalysisState['stage']>; title: string; detail: string }> = [
  { id: 'sample', title: 'Sample frames', detail: 'Seeking across the clip with a canvas capture' },
  { id: 'ocr', title: 'Read label text', detail: 'Tesseract.js OCR with word bounding boxes' },
  { id: 'compare', title: 'Compare evidence', detail: 'Token matching + palette overlap' },
  { id: 'report', title: 'Build report', detail: 'Checks, verdict and JSON export' },
];

const STAGE_ORDER = STEPS.map((step) => step.id);

export function VerifyPanel({
  brand,
  strictness,
  coverage,
  sampleCount,
  labelCritical,
  hasVideo,
  hasProduct,
  analysis,
  missing,
  stale,
  report,
  reference,
  region,
  onStrictnessChange,
  onCoverageChange,
  onSampleCountChange,
  onLabelCriticalChange,
  onRun,
  onRerunWithRegion,
  onClearRegion,
}: VerifyPanelProps) {
  const reportRef = useRef<HTMLDivElement | null>(null);
  const previousStatus = useRef<AnalysisState['status']>('idle');

  useEffect(() => {
    if (analysis.status === 'done' && previousStatus.current !== 'done') {
      reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    previousStatus.current = analysis.status;
  }, [analysis.status]);

  const running = analysis.status === 'running';
  const currentStage = analysis.stage ?? 'sample';
  const currentIndex = STAGE_ORDER.indexOf(currentStage);

  return (
    <Card
      index="04 · Verification"
      title="Product fidelity report"
      description="Browser-based OCR evidence. The clip and photo never leave this tab."
      aside={
        report ? (
          <Pill tone={statusTone(report.verdict === 'PASS' ? 'pass' : report.verdict === 'FAIL' ? 'fail' : 'review')} dot>
            {report.verdict}
          </Pill>
        ) : (
          <Pill tone="neutral">not run</Pill>
        )
      }
    >
      <div className="verify">
        <div className="settings">
          <div className="settings__grid">
            <label className="setting">
              <span className="setting__label">Match strictness</span>
              <select
                className="input"
                value={strictness}
                onChange={(event) => onStrictnessChange(event.target.value as VerifyConfig['strictness'])}
                disabled={running}
              >
                <option value="strict">Strict · exacting OCR</option>
                <option value="balanced">Balanced · recommended</option>
                <option value="lenient">Lenient · noisy frames</option>
              </select>
            </label>

            <label className="setting">
              <span className="setting__label">Frame samples</span>
              <select
                className="input"
                value={sampleCount}
                onChange={(event) => onSampleCountChange(Number(event.target.value))}
                disabled={running}
              >
                <option value={6}>6 frames · fastest</option>
                <option value={12}>12 frames · balanced</option>
                <option value={18}>18 frames · thorough</option>
              </select>
            </label>

            <label className="setting setting--range">
              <span className="setting__label">
                Required coverage <output>{Math.round(coverage * 100)}%</output>
              </span>
              <input
                type="range"
                min={40}
                max={90}
                step={10}
                value={Math.round(coverage * 100)}
                onChange={(event) => onCoverageChange(Number(event.target.value) / 100)}
                disabled={running}
              />
            </label>

            <label className="setting setting--check">
              <input
                type="checkbox"
                checked={labelCritical}
                onChange={(event) => onLabelCriticalChange(event.target.checked)}
                disabled={running}
              />
              <span>
                Treat missing label text as critical
                <span className="setting__hint">
                  On: a label failure produces FAIL. Off: it still affects the verdict, but cannot force FAIL.
                </span>
              </span>
            </label>
          </div>
          <p className="micro">
            Strictness sets the token similarity threshold to {Math.round(thresholdFor(strictness) * 100)}% with a
            matching minimum OCR word confidence. Coverage is the share of readable frames that must contain the expected
            text. Unreadable frames are never counted as mismatches. Verification runs a full-frame pass plus an
            automatic or manual label crop with grayscale, contrast and adaptive-threshold OCR variants.
          </p>
        </div>

        <div className="runbar">
          <ul className="reqs">
            <li className={`reqs__item ${hasVideo ? 'reqs__item--ok' : ''}`}>
              <span aria-hidden="true">{hasVideo ? '✓' : '○'}</span> Clip loaded
            </li>
            <li className={`reqs__item ${brand.trim() ? 'reqs__item--ok' : ''}`}>
              <span aria-hidden="true">{brand.trim() ? '✓' : '○'}</span> Brand name
            </li>
            <li className={`reqs__item ${hasProduct ? 'reqs__item--ok' : 'reqs__item--optional'}`}>
              <span aria-hidden="true">{hasProduct ? '✓' : '○'}</span> Product photo <em>optional</em>
            </li>
          </ul>
          <button type="button" className="btn btn--primary btn--lg" onClick={onRun} disabled={running || missing.length > 0}>
            {running ? 'Verifying…' : report ? 'Verify again' : 'Verify product fidelity'}
          </button>
        </div>

        {missing.length > 0 && (
          <p className="micro micro--warn">Still needed: {missing.join(' · ')}.</p>
        )}

        {running && (
          <div className="progress" aria-live="polite">
            <div className="progress__head">
              <span className="progress__message">{analysis.message ?? 'Starting analysis'}</span>
              <span className="progress__pct">{Math.round(analysis.progress * 100)}%</span>
            </div>
            <div className="progress__track">
              <span style={{ width: `${Math.round(analysis.progress * 100)}%` }} />
            </div>
            <ol className="progress__steps">
              {STEPS.map((step, index) => {
                const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';
                return (
                  <li key={step.id} className={`progress__step progress__step--${state}`}>
                    <span className="progress__dot" aria-hidden="true" />
                    <span>
                      <strong>{step.title}</strong>
                      <span className="micro">{step.detail}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {analysis.status === 'error' && (
          <Alert tone="error" title="Verification could not finish">
            {analysis.error ?? 'An unknown error occurred while reading the clip.'}
          </Alert>
        )}

        {stale && report && !running && (
          <Alert tone="warn" title="The brief changed after this report">
            The settings or assets no longer match the report below. Run verification again for current evidence.
          </Alert>
        )}

        <p className="micro">
          Automated consistency check — not proof that the product is identical in every frame. OCR reads only what is
          rendered; small or curved label text may be unreadable.
        </p>
      </div>

      {report && (
        <div className="report" ref={reportRef}>
          <EvidenceReport
            report={report}
            reference={reference}
            region={region}
            busy={running}
            onRerunWithRegion={onRerunWithRegion}
            onClearRegion={onClearRegion}
          />
        </div>
      )}
    </Card>
  );
}
