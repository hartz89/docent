import type { ReviewSnapshot, StopView, TourState } from '@docent/server';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, followTour } from './api.ts';
import { HealthPage } from './health-page.tsx';
import { StatusScreen } from './status-screen.tsx';
import { ThemeToggle } from './theme.tsx';
import { TourScreen } from './tour-screen.tsx';

export type Snapshot = ReviewSnapshot;
type Ready = Extract<TourState, { state: 'ready' }>;
type Working = Extract<TourState, { state: 'working' }>;

/**
 * The review screen. Once the PR is read, it's the tour screen from then on: the description and
 * files while the guide reads, each stop as it's written and checked, then the finished tour.
 */
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
  // The tab names the PR, "Title · Docent", the usual "page · site" order, so tabs stay
  // distinguishable when several reviews are open. Until the PR is read, it's just "Docent".
  const prTitle = data?.pr?.title;
  useEffect(() => {
    document.title = prTitle ? `${prTitle} · Docent` : 'Docent';
  }, [prTitle]);
  useEffect(() => {
    if (!data) return;
    if (data.tour.state !== 'working') {
      setTour(data.tour);
      return;
    }
    const controller = new AbortController();
    followTour(setTour, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setTour({
        state: 'failed',
        reason: `Lost the progress stream: ${String(error)}`,
        costs: [],
      });
    });
    return () => controller.abort();
  }, [data]);

  // The PR and diff arrive once the server has read them; fetch them as soon as they exist.
  const stillReading = tour?.state === 'working' && tour.steps[0]?.status === 'active';
  const refetch = snapshot.refetch;
  const missingPr = data !== undefined && data !== null && data.pr === null;
  const started = tour !== null;
  useEffect(() => {
    if (missingPr && started && !stillReading) void refetch();
  }, [missingPr, started, stillReading, refetch]);
  // Who answers questions is settled by the time the tour is ready; fetch it then if we missed it.
  const unknownAuthor = data !== undefined && data !== null && data.author === null;
  const isReady = tour?.state === 'ready';
  useEffect(() => {
    if (unknownAuthor && isReady) void refetch();
  }, [unknownAuthor, isReady, refetch]);

  if (snapshot.isPending) return <div className="app" />;
  if (snapshot.isError) {
    return (
      <div className="app">
        <StatusScreen tour={{ state: 'failed', reason: snapshot.error.message, costs: [] }} />
      </div>
    );
  }
  if (data === null || data === undefined) return <HealthPage />;

  const current = tour ?? data.tour;
  return current.state !== 'failed' && data.pr && data.diff ? (
    <TourScreen snapshot={{ ...data, tour: current }} tour={current} />
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
      <ThemeToggle />
    </header>
  );
}

export type { Ready, StopView, Working };
