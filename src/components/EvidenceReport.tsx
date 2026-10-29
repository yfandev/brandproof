import { useState } from 'react';
import type {
  FrameSample,
  Rect,
  ReferenceAsset,
  TokenEvidence,
  TokenFinding,
  TokenMatch,
  TokenStatus,
  VerificationReport,
} from '../types';
import { downloadReport } from '../lib/report';
import { RegionPicker } from './RegionPicker';
import { CheckIcon, FRAME_STATUS_LABEL, Pill, formatSeconds, statusTone, type Tone } from './ui';

interface EvidenceReportProps {
  report: VerificationReport;
  reference: ReferenceAsset | null;
  region: Rect | null;
  busy: boolean;
  onRerunWithRegion: (rect: Rect) => void;
  onClearRegion: () => void;
}

const TOKEN_SYMBOL: Record<TokenStatus, string> = {
  match: '✓',
  near: '~',
  missing: '—',
  unreadable: '?',
};

const TOKEN_STATUS_LABEL: Record<TokenStatus, string> = {
  match: 'MATCH',
  near: 'VISIBLY DISTORTED',
  missing: 'NOT DETECTED',
  unreadable: 'UNREADABLE',
};

const TOKEN_FINDING_LABEL: Record<TokenFinding, string> = {
  verified: 'VERIFIED',
  detected: 'DETECTED',
  'visibly-distorted': 'VISIBLY DISTORTED',
  'not-detected': 'NOT DETECTED',
  unreadable: 'UNREADABLE',
  'insufficient-evidence': 'INSUFFICIENT EVIDENCE',
};

const REGION_SOURCE_LABEL: Record<NonNullable<FrameSample['ocrRegionSource']>, string> = {
  manual: 'manual label area',
  auto: 'automatic label crop',
  'full-frame': 'full frame',
};

function bboxKey(match: TokenMatch): string {
  return `${match.bbox?.x0}-${match.bbox?.y0}-${match.bbox?.x1}-${match.bbox?.y1}`;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function WordOverlay({ frame }: { frame: FrameSample }) {
  const highlights = new Map<string, 'match' | 'near'>();
  for (const token of [...frame.brand, ...frame.label]) {
    if (!token.bbox) continue;
    const key = bboxKey(token);
    if (token.status === 'match') highlights.set(key, 'match');
    else if (token.status === 'near' && highlights.get(key) !== 'match') highlights.set(key, 'near');
  }

  return (
    <svg className="overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      {frame.words.map((word, index) => {
        const key = `${word.bbox.x0}-${word.bbox.y0}-${word.bbox.x1}-${word.bbox.y1}`;
        const status = highlights.get(key) ?? 'other';
        return (
          <rect
            key={`${key}-${index}`}
            x={word.bbox.x0}
            y={word.bbox.y0}
            width={Math.max(0.001, word.bbox.x1 - word.bbox.x0)}
            height={Math.max(0.001, word.bbox.y1 - word.bbox.y0)}
            className={`overlay__box overlay__box--${status}`}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

function TokenChip({ token, kind }: { token: TokenMatch; kind: 'brand' | 'label' }) {
  return (
    <span
      className={`tok tok--${token.status}`}
      title={
        token.matched
          ? `${kind} token · best reading “${token.matched}” · ${Math.round(token.similarity * 100)}% similar${
              token.confidence !== null ? ` · word confidence ${Math.round(token.confidence)}` : ''
            }`
          : `${kind} token · ${TOKEN_STATUS_LABEL[token.status]} · no readable candidate`
      }
    >
      <span className="tok__kind" aria-hidden="true">
        {kind === 'brand' ? 'B' : 'L'}
      </span>
      <span className="tok__expected">{token.expected}</span>
      <span className="tok__mark">{TOKEN_SYMBOL[token.status]}</span>
      {token.status !== 'match' && (
        <span className={`tok__status tok__status--${token.status}`}>
          {TOKEN_STATUS_LABEL[token.status]}
        </span>
      )}
      {token.matched && token.status !== 'match' && (
        <span className="tok__reading">“{token.matched}”</span>
      )}
    </span>
  );
}

function tokenTone(evidence: TokenEvidence): Tone {
  switch (evidence.finding) {
    case 'verified':
      return 'pass';
    case 'visibly-distorted':
      return 'fail';
    case 'detected':
    case 'not-detected':
      return 'review';
    case 'unreadable':
    case 'insufficient-evidence':
    default:
      return 'neutral';
  }
}

function TokenMatrix({ report }: { report: VerificationReport }) {
  if (report.tokenEvidence.length === 0) return null;

  return (
    <div className="matrix">
      <div className="block__head">
        <h3>Token coverage</h3>
        <p>Every expected token across every sampled frame. Hover a cell for its OCR reading and similarity.</p>
      </div>
      <div className="matrix__scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Expected token</th>
              <th scope="col">Kind</th>
              <th scope="col">Best reading</th>
              {report.frames.map((frame) => (
                <th key={frame.index} scope="col">
                  {formatSeconds(frame.time)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.tokenEvidence.map((evidence) => (
              <tr key={`${evidence.kind}-${evidence.token}`}>
                <th scope="row">{evidence.token}</th>
                <td>
                  <Pill tone={evidence.kind === 'brand' ? 'accent' : 'neutral'}>{evidence.kind}</Pill>
                </td>
                <td className="matrix__best">
                  <Pill tone={tokenTone(evidence)}>{TOKEN_FINDING_LABEL[evidence.finding]}</Pill>
                  {evidence.bestReading && (
                    <span
                      className="matrix__reading"
                      title={`${Math.round(evidence.bestSimilarity * 100)}% similar${
                        evidence.bestConfidence !== null
                          ? ` · word confidence ${Math.round(evidence.bestConfidence)}`
                          : ''
                      }`}
                    >
                      “{evidence.bestReading}”
                    </span>
                  )}
                </td>
                {report.frames.map((frame) => {
                  const match = (evidence.kind === 'brand' ? frame.brand : frame.label).find(
                    (token) => token.expected === evidence.token,
                  );
                  const status: TokenStatus = match?.status ?? 'missing';
                  return (
                    <td
                      key={frame.index}
                      className={`matrix__cell matrix__cell--${status}`}
                      title={
                        match
                          ? `${TOKEN_STATUS_LABEL[status]} · ${Math.round(match.similarity * 100)}%${match.matched ? ` · “${match.matched}”` : ''}`
                          : 'not evaluated in this frame'
                      }
                    >
                      {TOKEN_SYMBOL[status]}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="micro">
        ✓ matched · ~ visibly distorted (repeated near-reading) · — not detected · ? frame unreadable. NOT DETECTED
        and UNREADABLE are insufficient evidence, not proof that the label changed.
      </p>
    </div>
  );
}

export function EvidenceReport({
  report,
  reference,
  region,
  busy,
  onRerunWithRegion,
  onClearRegion,
}: EvidenceReportProps) {
  const [selected, setSelected] = useState(0);
  const [marking, setMarking] = useState(false);
  const [draftRegion, setDraftRegion] = useState<Rect | null>(null);

  const frame = report.frames[Math.min(selected, report.frames.length - 1)];
  if (!frame) return null;

  const { metrics, config } = report;

  return (
    <div className="evidence-report">
      <div className={`verdict verdict--${report.verdict.toLowerCase()}`}>
        <div className="verdict__top">
          <div className="verdict__copy">
            <p className="eyebrow">Automated verdict</p>
            <p className="verdict__word">{report.verdict}</p>
            <h3 className="verdict__headline">{report.headline}</h3>
            <p className="verdict__summary">{report.summary}</p>
            <p className="micro verdict__stamp">
              {report.createdAt} · {report.schemaVersion} · {report.video.name} · {formatSeconds(report.video.duration)}
            </p>
          </div>
          <div className="verdict__actions">
            <button type="button" className="btn btn--primary" onClick={() => downloadReport(report)}>
              Download JSON report
            </button>
            <span className="micro">
              Config, checks, token evidence and per-frame word boxes. Frame images stay in the browser.
            </span>
          </div>
        </div>

        <dl className="verdict__stats">
          <div>
            <dt>Frames read</dt>
            <dd>
              {metrics.readableFrames}
              <span>/{metrics.sampledFrames}</span>
            </dd>
            <small>{metrics.requiredReadableFrames} required</small>
          </div>
          <div>
            <dt>Brand recall</dt>
            <dd>{pct(metrics.brandRecall)}</dd>
            <small>{metrics.brandHits} readable frames</small>
          </div>
          <div>
            <dt>Label recall</dt>
            <dd>{metrics.labelRecall === null ? 'n/a' : pct(metrics.labelRecall)}</dd>
            <small>{metrics.labelHits === null ? 'not configured' : `${metrics.labelHits} readable frames`}</small>
          </div>
          <div>
            <dt>Mean OCR confidence</dt>
            <dd>{metrics.meanConfidence || '—'}</dd>
            <small>0–100 across readable frames</small>
          </div>
          <div>
            <dt>Colour overlap</dt>
            <dd>{pct(metrics.paletteSimilarity)}</dd>
            <small>advisory only</small>
          </div>
        </dl>
      </div>

      <section className="block">
        <div className="block__head">
          <h3>Checks</h3>
          <p>Critical checks can produce FAIL. Advisory checks influence REVIEW at most.</p>
        </div>
        <ul className="checks">
          {report.checks.map((check) => (
            <li key={check.id} className={`check check--${check.status}`}>
              <CheckIcon status={check.status} />
              <div className="check__body">
                <p className="check__title">
                  {check.title}
                  {check.critical && <span className="tag">critical</span>}
                </p>
                <p className="check__detail">{check.detail}</p>
              </div>
              <div className="check__meta">
                <span className="check__metric">{check.metric}</span>
                <Pill tone={statusTone(check.status)}>{check.status}</Pill>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {report.diagnostics && (
        <section className="block">
          <div className="block__head">
            <h3>Capture &amp; OCR diagnostics</h3>
            <p>
              What the browser actually sampled. If the brand is read but small label lines are not, check the capture
              size and region here before treating it as a label change.
            </p>
          </div>
          <dl className="diagnostics">
            <div>
              <dt>Captured frame</dt>
              <dd>
                {report.diagnostics.capture.width}×{report.diagnostics.capture.height}
              </dd>
              <small>
                {report.diagnostics.capture.capturedFrames} of {report.diagnostics.capture.requestedFrames} requested
              </small>
            </div>
            <div>
              <dt>OCR passes</dt>
              <dd>{report.diagnostics.ocr.totalPasses}</dd>
              <small>{report.diagnostics.ocr.passesPerFrame.join(' / ')} per frame</small>
            </div>
            <div>
              <dt>Label regions</dt>
              <dd>{report.diagnostics.ocr.regionSources.map((source) => REGION_SOURCE_LABEL[source]).join(', ')}</dd>
              <small>automatic crop is derived from the brand or densest text</small>
            </div>
            <div>
              <dt>Merged words</dt>
              <dd>{report.diagnostics.ocr.totalWords}</dd>
              <small>across all sampled frames</small>
            </div>
          </dl>
          <p className="micro">
            {report.diagnostics.ocr.regionSources.includes('auto')
              ? 'The label crop is automatic and may clip surrounding text. Mark the label area manually if lines are still missing.'
              : 'No automatic crop was applied. A manual label area usually gives the best small-text result.'}
          </p>
        </section>
      )}

      <section className="block">
        <div className="block__head">
          <h3>Visual comparison</h3>
          <p>
            Reference photo against the selected frame. Colour overlap compares coarse histograms
            {region ? ' over the marked label area' : ''}; it is not an identity check.
          </p>
        </div>
        <div className="compare">
          <figure className="compare__figure">
            {reference ? (
              <RegionPicker
                src={reference.url}
                alt={`Original product photo: ${reference.name}`}
                rect={region}
                active={false}
                onChange={() => undefined}
                className="region--static"
              />
            ) : (
              <div className="compare__missing">No product photo was provided.</div>
            )}
            <figcaption>
              Reference · {reference ? `${reference.width}×${reference.height}` : 'not provided'}
            </figcaption>
          </figure>
          <div className="compare__meter">
            <span className="eyebrow">Palette overlap</span>
            <strong>{pct(metrics.paletteSimilarity)}</strong>
            <div className="meter" aria-hidden="true">
              <span style={{ width: `${Math.round((metrics.paletteSimilarity ?? 0) * 100)}%` }} />
            </div>
            <p className="micro">
              {config.region
                ? 'Computed from the same normalized label area on the reference and every frame.'
                : 'Computed from the full reference photo and full frames. Scene lighting shifts this legitimately.'}
            </p>
            {reference && (
              <div className="compare__swatches" aria-label="Reference palette">
                {reference.swatches.map((swatch) => (
                  <span key={swatch} className="swatch" style={{ background: swatch }} title={swatch} />
                ))}
              </div>
            )}
          </div>
          <figure className="compare__figure">
            <div className="compare__frame">
              <img src={frame.dataUrl} alt={`Sampled video frame at ${formatSeconds(frame.time)}`} />
              <WordOverlay frame={frame} />
            </div>
            <figcaption>
              Frame {frame.index + 1} · {formatSeconds(frame.time)} ·{' '}
              {FRAME_STATUS_LABEL[frame.status]}
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="block">
        <div className="block__head">
          <h3>Frame evidence</h3>
          <p>
            {report.frames.length} sampled frames with merged Tesseract word boxes from every OCR pass. Lime = matched
            expected token, amber = near match, grey = other recognised text. A frame without label text is reported as
            NOT DETECTED, not as a confirmed change.
          </p>
        </div>

        <div className="filmstrip" role="tablist" aria-label="Sampled frames">
          {report.frames.map((sample, index) => (
            <button
              key={sample.index}
              type="button"
              role="tab"
              aria-selected={index === selected}
              aria-label={`Frame ${sample.index + 1} at ${formatSeconds(sample.time)}, ${FRAME_STATUS_LABEL[sample.status]}`}
              className={`thumb ${index === selected ? 'thumb--active' : ''}`}
              onClick={() => {
                setSelected(index);
                setMarking(false);
                setDraftRegion(null);
              }}
            >
              <img src={sample.dataUrl} alt="" loading="lazy" />
              <span className={`thumb__status thumb__status--${sample.status}`} aria-hidden="true" />
              <span className="thumb__time">{formatSeconds(sample.time)}</span>
            </button>
          ))}
        </div>

        <div className="frame">
          <div className="frame__view">
            <RegionPicker
              src={frame.dataUrl}
              alt={`Frame at ${formatSeconds(frame.time)} with OCR boxes`}
              rect={marking ? draftRegion : region}
              active={marking}
              onChange={setDraftRegion}
              overlay={<WordOverlay frame={frame} />}
              className={marking ? 'region--marking' : ''}
            />
            <div className="frame__actions">
              {marking ? (
                <>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={!draftRegion || busy}
                    onClick={() => {
                      if (!draftRegion) return;
                      onRerunWithRegion(draftRegion);
                      setMarking(false);
                      setDraftRegion(null);
                    }}
                  >
                    Re-run with this area
                  </button>
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={() => {
                      setMarking(false);
                      setDraftRegion(null);
                    }}
                  >
                    Cancel
                  </button>
                  <span className="micro">Draw a box around the label on this frame.</span>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setMarking(true);
                      setDraftRegion(null);
                    }}
                    disabled={busy}
                  >
                    {region ? 'Redraw label area' : 'OCR failed? Mark label area'}
                  </button>
                  {region && (
                    <button type="button" className="btn btn--subtle btn--sm" onClick={onClearRegion} disabled={busy}>
                      Clear area
                    </button>
                  )}
                  <span className="micro">
                    {region
                      ? 'OCR restricted to this normalized area in every frame.'
                      : 'Region OCR helps when the label is small or the background is busy.'}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="frame__details">
            <header className="frame__head">
              <div>
                <p className="eyebrow">Frame {frame.index + 1}</p>
                <h4>{formatSeconds(frame.time)}</h4>
              </div>
              <Pill tone={statusTone(frame.status)} dot>
                {FRAME_STATUS_LABEL[frame.status]}
              </Pill>
            </header>

            <div className="frame__facts">
              <span>{frame.words.length} words</span>
              <span>{frame.ocrPasses?.length ?? 0} OCR passes</span>
              <span>{REGION_SOURCE_LABEL[frame.ocrRegionSource ?? 'full-frame']}</span>
              <span>OCR confidence {frame.meanConfidence || '—'}</span>
              <span>Frame palette {pct(frame.paletteSimilarity)}</span>
            </div>

            <div className="tokens">
              {frame.brand.map((token) => (
                <TokenChip key={`brand-${token.expected}`} token={token} kind="brand" />
              ))}
              {frame.label.map((token) => (
                <TokenChip key={`label-${token.expected}`} token={token} kind="label" />
              ))}
              {frame.brand.length + frame.label.length === 0 && (
                <p className="micro">No expected tokens configured.</p>
              )}
            </div>

            <div className="ocrtext">
              <p className="eyebrow">Recognised text</p>
              <pre>{frame.text || 'No text recognised in this frame.'}</pre>
            </div>

            {frame.notes.length > 0 && (
              <ul className="notes">
                {frame.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <TokenMatrix report={report} />
      </section>

      <section className="block block--note">
        <div className="block__head">
          <h3>What this report does not claim</h3>
          <p>
            BrandProof is an automated OCR consistency check. It verifies sampled frames against the text you entered —
            nothing more.
          </p>
        </div>
        <ul className="limitations">
          {report.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
        <p className="report-disclaimer">
          PASS means the configured checks passed with sufficient sampled evidence. REVIEW means the evidence is
          inconclusive. FAIL means a configured critical check demonstrably failed. None of these verdicts prove the
          product is identical in every frame.
        </p>
      </section>
    </div>
  );
}
