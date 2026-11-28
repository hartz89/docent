import type { TourState } from '@docent/server';
import { type ReactNode, useState } from 'react';

type Working = Extract<TourState, { state: 'working' }>;

/**
 * Before the PR is read, or when the tour couldn't be written: a card on its own. A failed tour
 * offers Try again, which `onRetry` handles; it resolves once the page is following the new try.
 */
export function StatusScreen({
  tour,
  onRetry,
}: {
  tour: TourState;
  onRetry?: () => Promise<void>;
}) {
  if (tour.state === 'failed') {
    return (
      <main className="status-screen">
        <section className="status-card fade-in" role="alert">
          <h2>The tour couldn't be written</h2>
          <p className="lede">Docent stopped before the guide finished. Here's what went wrong:</p>
          <pre className="error-reason">{tour.reason}</pre>
          <p className="error-hint">{hintFor(tour.reason)}</p>
          {onRetry && <RetryButton onRetry={onRetry} />}
        </section>
      </main>
    );
  }
  return (
    <main className="status-screen">
      <section className="status-card fade-in">
        <TourProgress tour={tour.state === 'working' ? tour : null} />
      </section>
    </main>
  );
}

/** What to do about a failed tour, by what's known of why it failed. */
function hintFor(reason: string): ReactNode {
  if (/rate.?limit|usage limit|\b429\b|overloaded/i.test(reason)) {
    return 'This looks like a usage limit. Wait a few minutes, then try again.';
  }
  if (/progress stream|server answered|failed to fetch|network/i.test(reason)) {
    return "Docent's server may have stopped. If its terminal still shows it running, try again.";
  }
  const checks = (
    <>
      check that <code>gh auth status</code> and <code>claude</code> both work in a terminal
    </>
  );
  // Not "author": a failure that mentions the author's session isn't a login problem.
  if (
    /\bauth(?:entication|enticated|orization|orized)?\b|not logged in|log ?in\b|credential|\b401\b/i.test(
      reason,
    )
  ) {
    return <>First {checks}, then try again.</>;
  }
  return (
    <>
      Often it's a passing hiccup, so try again. If it fails the same way, {checks}. Nothing was
      written to the repository.
    </>
  );
}

function RetryButton({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="status-actions">
      <button
        type="button"
        className="primary-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          // Back to Try again once the page has caught up: if the tour failed again, or the
          // server can't be reached, this card stays, and the button must work again.
          onRetry()
            .catch((failed: unknown) => {
              setError(failed instanceof Error ? failed.message : String(failed));
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Starting again…' : 'Try again'}
      </button>
      {error && <p className="status-error">Couldn't start again: {error}</p>}
    </div>
  );
}

/**
 * What the guide is doing right now, step by step, in its own words. No bar and no percentage:
 * nobody knows how long the guide will read, so the screen only says what is true.
 */
export function TourProgress({ tour }: { tour: Working | null }) {
  const steps = tour?.steps ?? [
    { id: 'checking', label: 'Checking the whole tour', status: 'done' as const },
  ];
  return (
    <div className="tour-progress" aria-live="polite" aria-busy="true">
      <h2>Preparing your tour</h2>
      <p className="lede">
        The guide is reading the change in its own fresh context. It describes; the verdict stays
        yours. Each stop appears as soon as it's written and its citations check out.
      </p>
      <ol className="steps">
        {steps.map((step) => (
          <li key={step.id} className={`step ${step.status}`}>
            <span className="step-dot" aria-hidden="true" />
            <span>
              {step.label}
              {step.status === 'active' ? '…' : ''}
              {step.status === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="step-detail">
        {tour && tour.attempt > 1 ? `Attempt ${tour.attempt} · ` : ''}
        {tour?.detail ?? ''}
      </p>
    </div>
  );
}
