import type { TourState } from '@docent/server';

/** Progress while the guide writes the tour, or the reason it couldn't. */
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
  const steps =
    tour.state === 'working'
      ? tour.steps
      : [{ id: 'checking', label: 'Checking citations', status: 'done' as const }];
  return (
    <main className="status-screen">
      <section className="status-card fade-in" aria-live="polite" aria-busy="true">
        <h2>Preparing your tour</h2>
        <p className="lede">
          The guide is reading the change in its own fresh context. It describes; the verdict stays
          yours.
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
          {tour.state === 'working' && tour.attempt > 1 ? `Attempt ${tour.attempt} · ` : ''}
          {tour.state === 'working' ? (tour.detail ?? '') : ''}
        </p>
      </section>
    </main>
  );
}
