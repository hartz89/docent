import type { ReviewSnapshot, StopView, TourState } from '@docent/server';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, followTour } from './api.ts';
import { HealthPage } from './health-page.tsx';
import { StatusScreen } from './status-screen.tsx';
import { TourScreen } from './tour-screen.tsx';

export type Snapshot = ReviewSnapshot;
type Ready = Extract<TourState, { state: 'ready' }>;

/** The review screen: progress while the tour is written, then the tour itself. */
export function ReviewPage() {
  const snapshot = useQuery({
    queryKey: ['review'],
    queryFn: async () => {
      const res = await api.review.$get();
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`The server answered ${(res as Response).status}`);
      return res.json();
    },
  });
  const [tour, setTour] = useState<TourState | null>(null);

  const data = snapshot.data;
  useEffect(() => {
    if (!data) return;
    if (data.tour.state !== 'working') {
      setTour(data.tour);
      return;
    }
    const controller = new AbortController();
    followTour(setTour, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setTour({ state: 'failed', reason: `Lost the progress stream: ${String(error)}` });
    });
    return () => controller.abort();
  }, [data]);

  // The PR and diff arrive once the server has read them; fetch them as soon as they exist.
  const stillReading = tour?.state === 'working' && tour.steps[0]?.status === 'active';
  const refetch = snapshot.refetch;
  const missingPr = data !== undefined && data !== null && data.pr === null;
  useEffect(() => {
    if (missingPr && tour && !stillReading) void refetch();
  }, [missingPr, tour, stillReading, refetch]);

  if (snapshot.isPending) return <div className="app" />;
  if (snapshot.isError) {
    return (
      <div className="app">
        <StatusScreen tour={{ state: 'failed', reason: snapshot.error.message }} />
      </div>
    );
  }
  if (data === null || data === undefined) return <HealthPage />;

  const current = tour ?? data.tour;
  return current.state === 'ready' && data.pr && data.diff ? (
    <TourScreen snapshot={{ ...data, tour: current }} tour={current as Ready} />
  ) : (
    <div className="app">
      <TopBarShell snapshot={data} />
      <StatusScreen tour={current} />
    </div>
  );
}

function TopBarShell({ snapshot }: { snapshot: Snapshot }) {
  return (
    <header className="topbar">
      <span className="brand">Docent</span>
      <div className="pr-heading">
        <h1 className="pr-title">{snapshot.pr?.title ?? 'Opening the pull request…'}</h1>
        {snapshot.pr && (
          <div className="pr-meta">
            <span>{snapshot.pr.repo}</span>
            <span>#{snapshot.pr.number}</span>
          </div>
        )}
      </div>
    </header>
  );
}

export type { Ready, StopView };
