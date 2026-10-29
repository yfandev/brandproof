import type { ReactNode } from 'react';
import type { CheckStatus, FrameStatus } from '../types';

export type Tone = 'neutral' | 'accent' | 'pass' | 'review' | 'fail' | 'info';

export function Pill({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`pill pill--${tone}`}>
      {dot && <span className="pill__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Card({
  index,
  title,
  description,
  aside,
  children,
  className = '',
  anchor,
}: {
  index?: string;
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  anchor?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()} id={anchor}>
      <header className="panel__head">
        <div className="panel__heading">
          {index && <p className="panel__index">{index}</p>}
          <h2 className="panel__title">{title}</h2>
          {description && <p className="panel__desc">{description}</p>}
        </div>
        {aside && <div className="panel__aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  optional,
  children,
  counter,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  optional?: boolean;
  children: ReactNode;
  counter?: string;
}) {
  return (
    <div className="field">
      <div className="field__labelrow">
        <label className="field__label" htmlFor={htmlFor}>
          {label}
          {optional && <span className="field__optional">optional</span>}
        </label>
        {counter && <span className="field__counter">{counter}</span>}
      </div>
      {children}
      {hint && <p className="field__hint">{hint}</p>}
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  onDismiss,
}: {
  tone?: 'error' | 'warn' | 'info';
  title: string;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="alert__body">
        <p className="alert__title">{title}</p>
        {children && <div className="alert__text">{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="alert__close" onClick={onDismiss} aria-label="Dismiss message">
          ×
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon" aria-hidden="true">{icon}</div>}
      <p className="empty__title">{title}</p>
      {children && <div className="empty__text">{children}</div>}
    </div>
  );
}

const CHECK_SYMBOL: Record<CheckStatus, string> = {
  pass: '✓',
  review: '!',
  fail: '×',
  skipped: '–',
};

export function CheckIcon({ status }: { status: CheckStatus }) {
  return (
    <span className={`checkicon checkicon--${status}`} aria-hidden="true">
      {CHECK_SYMBOL[status]}
    </span>
  );
}

export const FRAME_STATUS_LABEL: Record<FrameStatus, string> = {
  pass: 'labelled',
  review: 'partial',
  fail: 'altered',
  unreadable: 'unreadable',
};

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const whole = Math.floor(seconds);
  const decimals = seconds - whole;
  return `${whole}.${Math.round(decimals * 10)}s`;
}

export function statusTone(status: CheckStatus | FrameStatus): Tone {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    case 'unreadable':
    case 'skipped':
      return 'neutral';
    default:
      return 'review';
  }
}
