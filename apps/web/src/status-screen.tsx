import type { TourState } from '@docent/server';

type Working = Extract<TourState, { state: 'working' }>;

/** Before the PR is read, or when the tour couldn't be written: a card on its own. */
export function StatusScreen({ tour }: { tour: TourState }) {
  if (tour.state === 'failed') {
    return (
      <main className="status-screen">
        <section className="status-card fade-in" role="alert">
          <h2>The tour couldn't be written</h2>
          <p className="lede">Docent stopped before the guide finished. Here's what went wrong:</p>
          <pre className="error-reason">{tour.reason}</pre>
          <p className="error-hint">
            Check that <code>gh auth status</code> and <code>claude</code> both work in a terminal,
            then run the command again. Nothing was written to the repository.
          </p>
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
