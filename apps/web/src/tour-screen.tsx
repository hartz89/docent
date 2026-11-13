import type {
  AnchorView,
  AnswerView,
  AuthorView,
  CorrectionView,
  PostedReview,
  ReviewSnapshot,
  StopView,
} from '@docent/server';
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from './api.ts';
import { CodeView } from './code-view.tsx';
import { FileTree } from './file-tree.tsx';
import {
  back,
  canGoBack,
  canGoForward,
  current,
  emptyTrail,
  forward,
  type Trail,
  visit,
} from './jump.ts';
import { Markdown } from './markdown.tsx';
import type { Ready, Working } from './review-page.tsx';
import {
  DRAWER_QUERY,
  RouteDrawer,
  RouteIcon,
  STACKED_QUERY,
  useMediaQuery,
} from './route-drawer.tsx';
import { report } from './run-log.ts';
import { TourProgress } from './status-screen.tsx';
import { ThemeToggle } from './theme.tsx';
import { postedLabel, VerdictForm } from './verdict.tsx';

/** The finished tour, or the stops written and checked so far while the guide writes the rest. */
type Props = { snapshot: ReviewSnapshot; tour: Ready | Working };
type Diff = NonNullable<ReviewSnapshot['diff']>;
/** A file opened outside the stop's citations, at the lines in focus if any. */
type Viewing = {
  path: string;
  side: 'old' | 'new';
  focus?: { startLine: number; endLine: number };
  label?: string;
};

const sameView = (a: Viewing, b: Viewing) =>
  a.path === b.path && a.side === b.side && a.focus?.startLine === b.focus?.startLine;

/** Alt+← and Alt+→ move through explored files, as an editor's back and forward do. */
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const BACK_KEYS = isMac ? '⌥←' : 'Alt+←';
const FORWARD_KEYS = isMac ? '⌥→' : 'Alt+→';

const KIND_LABELS: Record<StopView['kind'], string> = {
  intent: 'Intent',
  map: 'Map',
  core_change: 'Core change',
  edge: 'Edge',
  verdict_prompt: 'Your verdict',
};

export function TourScreen({ snapshot, tour }: Props) {
  const ready = tour.state === 'ready' ? tour : null;
  const stops = ready ? ready.tour.stops : (tour as Working).stops;
  const skips = ready?.tour.skips ?? [];
  const writing = ready ? null : (tour as Working);
  const [index, setIndex] = useState(0);
  const [anchorIndex, setAnchorIndex] = useState(0);
  // Files opened from the skip list, the overview, the file tree or a jump to definition, in place
  // of the stop's citation. Back and forward move along the trail; the stop is always its start.
  const [trail, setTrail] = useState<Trail<Viewing>>(emptyTrail);
  const viewing = current(trail);
  const explore = useCallback((view: Viewing) => setTrail((t) => visit(t, view, sameView)), []);
  const toTour = useCallback(() => setTrail(emptyTrail()), []);
  // The left pane shows the route or the whole repo's files.
  const [pane, setPane] = useState<'route' | 'files'>('route');
  const goToFile = useRef<HTMLInputElement>(null);
  // A reviewer who opened the review while the tour was still being written is reading the PR's
  // description. Stops arriving don't take the code column away from it; moving does.
  const [overviewFirst, setOverviewFirst] = useState(tour.state !== 'ready');
  // Each stop's questions and answers, kept here so they survive moving between stops.
  const [threads, setThreads] = useState<Record<string, Exchange[]>>({});
  // The review posted to GitHub from here, if any. A reload gets it from the snapshot.
  const [posted, setPosted] = useState<PostedReview | null>(snapshot.posted);
  const ask = useCallback(async (stopId: string, question: string) => {
    // Each exchange has its own id, so an answer always lands on the question it answers.
    const id = crypto.randomUUID();
    const settle = (patch: Partial<Exchange>) =>
      setThreads((all) => ({
        ...all,
        [stopId]: (all[stopId] ?? []).map((e) => (e.id === id ? { ...e, ...patch } : e)),
      }));
    setThreads((all) => ({
      ...all,
      [stopId]: [
        ...(all[stopId] ?? []),
        { id, question, answer: null, error: null, correction: null },
      ],
    }));
    let checkId: string | null = null;
    try {
      const res = await api.questions.$post({ json: { stopId, question } });
      const body = await res.json();
      if ('answer' in body) {
        settle({ answer: body.answer });
        if (body.answer.source === 'author_session') checkId = body.answer.checkId;
      } else settle({ error: body.error });
    } catch (error) {
      settle({ error: error instanceof Error ? error.message : String(error) });
    }
    // The guide's check of the author's answer comes after it, and only ever adds a correction.
    // If it fails, it says nothing.
    if (!checkId) return;
    try {
      const res = await api['answer-checks'][':id'].$get({ param: { id: checkId } });
      if (res.status !== 200) return;
      const { correction } = await res.json();
      if (correction) settle({ correction });
    } catch {
      // Silence, as when the answer holds up.
    }
  }, []);

  // Under 1200px wide the route leaves its column for a drawer; under 800px the layout stacks,
  // and a bottom bar moves between stops.
  const drawer = useMediaQuery(DRAWER_QUERY);
  const stacked = useMediaQuery(STACKED_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const routeOpen = drawer && drawerOpen;
  const openRoute = useCallback(() => setDrawerOpen(true), []);
  const closeRoute = useCallback(() => setDrawerOpen(false), []);
  // Widening past 1200px with the drawer open (a rotated tablet, a zoom) takes the drawer and its
  // opener away. Forget it was open, so narrowing again doesn't reopen it, and move focus to the
  // current stop in the route's column rather than leaving it on the page body.
  useEffect(() => {
    if (drawer || !drawerOpen) return;
    setDrawerOpen(false);
    document
      .querySelector<HTMLElement>('nav[aria-label="Route and files"] [aria-current="step"]')
      ?.focus();
  }, [drawer, drawerOpen]);

  const stop = stops[index];
  // When the finished tour replaces the streamed stops, a repair may have added a stop before
  // this one. Follow the stop the reviewer was reading, by its title, not its number.
  const reading = useRef<{ stops: readonly StopView[]; title: string | null } | null>(null);
  // A layout effect, so the wrong stop never shows for a frame.
  useLayoutEffect(() => {
    const was = reading.current;
    const title = stops[index]?.title ?? null;
    // Only a new list of stops re-selects; the reviewer moving changes the title on purpose.
    if (was && was.stops !== stops && was.title !== null && title !== was.title) {
      const moved = stops.findIndex((s) => s.title === was.title);
      // A whole new tour may have dropped that stop: stay as close as the new route allows.
      const next = moved !== -1 ? moved : Math.min(index, Math.max(0, stops.length - 1));
      if (next !== index) {
        reading.current = { stops, title: stops[next]?.title ?? null };
        setIndex(next);
        return;
      }
    }
    reading.current = { stops, title };
  }, [stops, index]);
  // The guide outlives each stop, so it would keep the last stop's scroll position. A stop seen
  // for the first time opens at the top; a revisited stop opens where it was left. The guide
  // scrolls in its own column, or, in the stacked phone layout, the columns scroll together.
  const guide = useRef<HTMLElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  const scrollByStop = useRef(new Map<string, [number, number]>());
  const go = useCallback(
    (next: number) => {
      if (stop && guide.current && columns.current) {
        scrollByStop.current.set(stop.id, [guide.current.scrollTop, columns.current.scrollTop]);
      }
      setIndex(Math.max(0, Math.min(stops.length - 1, next)));
      setAnchorIndex(0);
      setOverviewFirst(false);
      setTrail(emptyTrail());
    },
    [stop, stops.length],
  );
  // ↑ ↓ in the code view move between this stop's citations once one is read through.
  const anchorCount = stop?.anchors.length ?? 0;
  const stepAnchor = useCallback(
    (delta: 1 | -1) => {
      const next = anchorIndex + delta;
      if (next < 0 || next >= anchorCount) return false;
      setAnchorIndex(next);
      return true;
    },
    [anchorIndex, anchorCount],
  );
  const stopId = stop?.id;
  useEffect(() => {
    if (stopId) report({ kind: 'ui.stop', stop: index + 1, stopId });
  }, [stopId, index]);
  useLayoutEffect(() => {
    if (!guide.current || !columns.current || !stopId) return;
    const [guideTop, columnsTop] = scrollByStop.current.get(stopId) ?? [0, 0];
    guide.current.scrollTop = guideTop;
    columns.current.scrollTop = columnsTop;
  }, [stopId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // In the route drawer, keys belong to the drawer.
      if (target?.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(index + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(index - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index]);

  // Esc leaves explored files for the tour; Alt+← and Alt+→ go back and forward among them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      if (event.key === 'Escape' && !event.altKey && trail.at >= 0) {
        event.preventDefault();
        toTour();
      } else if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        // Always kept from the browser: elsewhere than macOS, Alt+← is its own Back, and one
        // press too many would leave the review.
        event.preventDefault();
        setTrail(event.key === 'ArrowLeft' ? back : forward);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trail, toTour]);

  // ⌘P (Ctrl+P elsewhere) jumps to "Go to file", as in an editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'p' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      setPane('files');
      if (drawer) setDrawerOpen(true);
      requestAnimationFrame(() => goToFile.current?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const diff = snapshot.diff as Diff;
  const changes = useMemo(() => changedLines(diff), [diff]);
  const onRoute = useMemo(
    () => new Set(stops.flatMap((s) => s.anchors.map((a) => a.path))),
    [stops],
  );
  if (!snapshot.pr) return null;

  const anchor = stop?.anchors[anchorIndex] ?? null;
  const shown: Viewing | null =
    viewing ?? (anchor && !overviewFirst ? { path: anchor.path, side: anchor.side } : null);
  const cited =
    shown && stop ? stop.anchors.filter((a) => a.path === shown.path && a.side === shown.side) : [];

  // The route and the file tree, as tabs: in their own column, or in the drawer.
  const leftPane = (
    <>
      <div className="pane-switch" role="tablist" aria-label="Left pane">
        <button
          type="button"
          role="tab"
          id="tab-route"
          aria-selected={pane === 'route'}
          aria-controls="pane-route"
          onClick={() => setPane('route')}
        >
          Route <span className="pane-count">{stops.length} stops</span>
        </button>
        <button
          type="button"
          role="tab"
          id="tab-files"
          aria-selected={pane === 'files'}
          aria-controls="pane-files"
          onClick={() => setPane('files')}
        >
          Files <span className="pane-count">{diff.files.length} changed</span>
        </button>
      </div>
      <div role="tabpanel" id="pane-route" aria-labelledby="tab-route" hidden={pane !== 'route'}>
        <Route
          stops={stops}
          index={index}
          onSelect={(i) => {
            go(i);
            closeRoute();
          }}
          skips={skips}
          onOpenSkip={(path) => {
            explore({ path, side: sideFor(diff, path) });
            closeRoute();
          }}
          tour={ready}
          writing={writing}
        />
      </div>
      <div role="tabpanel" id="pane-files" aria-labelledby="tab-files" hidden={pane !== 'files'}>
        <FileTree
          diff={diff}
          onRoute={onRoute}
          selected={shown?.side === 'new' ? shown.path : null}
          onOpen={(path) => {
            explore({ path, side: 'new' });
            closeRoute();
          }}
          filterRef={goToFile}
        />
      </div>
    </>
  );

  return (
    <div className="app">
      <TopBar
        snapshot={snapshot}
        diff={diff}
        index={index}
        total={stops.length}
        finished={ready !== null}
        posted={posted}
        drawer={drawer ? { open: routeOpen, onOpen: openRoute } : null}
      />
      <div className="columns" ref={columns}>
        {drawer ? (
          <RouteDrawer open={routeOpen} onClose={closeRoute}>
            {leftPane}
          </RouteDrawer>
        ) : (
          <nav className="column left-column" aria-label="Route and files">
            {leftPane}
          </nav>
        )}
        <section className="column code-column" aria-label="Code">
          {shown ? (
            <>
              <div className="code-header">
                {/* Truncates from the start, so the file name stays in view. */}
                <span className="code-path" title={shown.path}>
                  <bdi>{shown.path}</bdi>
                </span>
                <span className="code-range">
                  {viewing
                    ? (viewing.label ??
                      (diff.files.some((f) => f.path === shown.path)
                        ? 'changed in this PR'
                        : 'not changed by this PR · read-only'))
                    : anchor
                      ? `lines ${anchor.startLine}–${anchor.endLine} · cited by this stop`
                      : ''}
                </span>
                <span className="code-side">{shown.side === 'new' ? 'head' : 'base'}</span>
                {trail.entries.length > 0 && (
                  <span className="trail-nav">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Back"
                      title={`Back (${BACK_KEYS})`}
                      disabled={!canGoBack(trail)}
                      onClick={() => setTrail(back)}
                    >
                      <span aria-hidden="true">‹</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Forward"
                      title={`Forward (${FORWARD_KEYS})`}
                      disabled={!canGoForward(trail)}
                      onClick={() => setTrail(forward)}
                    >
                      <span aria-hidden="true">›</span>
                    </button>
                  </span>
                )}
                {viewing && (
                  <button
                    type="button"
                    className="secondary-button back-to-stop"
                    title="Back to the tour (Esc)"
                    onClick={toTour}
                  >
                    <span aria-hidden="true">←</span>{' '}
                    {stop && !overviewFirst ? `Back to stop ${index + 1}` : 'Back to the overview'}
                  </button>
                )}
              </div>
              <CodeView
                path={shown.path}
                side={shown.side}
                cited={viewing ? (viewing.focus ? [viewing.focus] : []) : cited}
                focus={viewing ? (viewing.focus ?? null) : anchor}
                changed={changes.get(`${shown.side}:${shown.path}`) ?? new Set()}
                onStep={viewing ? undefined : stepAnchor}
                onJump={(to) =>
                  explore({
                    path: to.path,
                    side: 'new',
                    ...(to.line ? { focus: { startLine: to.line, endLine: to.line } } : {}),
                    label: to.line ? `line ${to.line} · ${to.label}` : to.label,
                  })
                }
              />
            </>
          ) : (
            <Overview snapshot={snapshot} diff={diff} onOpen={explore} />
          )}
        </section>
        <aside className="column" aria-label="The guide" ref={guide}>
          {!stop ? (
            <div className="narration">
              <div className="narration-body fade-in">
                <TourProgress tour={writing} />
              </div>
            </div>
          ) : (
            <Narration
              key={stop.id}
              stop={stop}
              author={snapshot.author}
              exchanges={threads[stop.id] ?? []}
              onAsk={(question) => void ask(stop.id, question)}
              onOpenCite={(cite) =>
                explore({
                  path: cite.path,
                  side: cite.side,
                  focus: cite,
                  label: `lines ${cite.startLine}–${cite.endLine} · cited by the guide's note`,
                })
              }
              activeAnchor={viewing || overviewFirst ? -1 : anchorIndex}
              onAnchor={(i) => {
                setOverviewFirst(false);
                setAnchorIndex(i);
                toTour();
              }}
              isLast={index === stops.length - 1}
              onNext={() => go(index + 1)}
              finished={ready !== null}
              waiting={
                writing?.attempt === 1 &&
                writing.steps.find((s) => s.status === 'active')?.id === 'writing'
                  ? 'Writing the next stop…'
                  : 'Checking the whole tour…'
              }
              verdict={
                stop.kind !== 'verdict_prompt' ? null : ready ? (
                  <VerdictForm pr={snapshot.pr} posted={posted} onPosted={setPosted} />
                ) : (
                  <p className="waiting-note">
                    Your verdict opens once the whole tour is written and checked.
                  </p>
                )
              }
            />
          )}
        </aside>
      </div>
      {stacked && (
        <StopBar
          index={index}
          total={stops.length}
          finished={ready !== null}
          onGo={go}
          onOpenRoute={openRoute}
        />
      )}
    </div>
  );
}

/** The phone layout's bottom bar: the route, and the way between stops. */
function StopBar({
  index,
  total,
  finished,
  onGo,
  onOpenRoute,
}: {
  index: number;
  total: number;
  finished: boolean;
  onGo: (index: number) => void;
  onOpenRoute: () => void;
}) {
  return (
    <nav className="stop-bar" aria-label="Stops">
      <button type="button" className="stop-bar-route" aria-haspopup="dialog" onClick={onOpenRoute}>
        <RouteIcon /> Route
      </button>
      <div className="stop-bar-steps">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous stop"
          disabled={index === 0}
          onClick={() => onGo(index - 1)}
        >
          <span aria-hidden="true">←</span>
        </button>
        <span className="stop-bar-count">{progressText(index, total, finished)}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Next stop"
          disabled={index >= total - 1}
          onClick={() => onGo(index + 1)}
        >
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </nav>
  );
}

function TopBar({
  snapshot,
  diff,
  index,
  total,
  finished,
  posted,
  drawer,
}: {
  snapshot: ReviewSnapshot;
  diff: Diff;
  index: number;
  total: number;
  /** False while stops are still being written, so the total isn't known yet. */
  finished: boolean;
  posted: PostedReview | null;
  /** How to open the route when it's a drawer; null when it has its own column. */
  drawer: { open: boolean; onOpen: () => void } | null;
}) {
  const pr = snapshot.pr;
  const lines = diff.files.flatMap((f) => f.hunks.flatMap((h) => h.lines));
  const added = lines.filter((l) => l.kind === 'added').length;
  const removed = lines.filter((l) => l.kind === 'removed').length;
  return (
    <header className="topbar">
      {drawer && (
        <button
          type="button"
          className="icon-button route-toggle"
          aria-label="Open the route"
          title="Open the route"
          aria-haspopup="dialog"
          aria-expanded={drawer.open}
          onClick={drawer.onOpen}
        >
          <RouteIcon />
        </button>
      )}
      <span className="brand">Docent</span>
      <div className="pr-heading">
        <h1 className="pr-title" title={pr?.title}>
          {pr?.title}
        </h1>
        {/* Narrow windows drop meta items by priority: the commit first, then files, then repo. */}
        <div className="pr-meta">
          <span className="meta-repo">{pr?.repo}</span>
          <a
            href={pr?.url}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'inherit', textDecoration: 'none' }}
          >
            #{pr?.number}
          </a>
          <span className="mono meta-head">{pr?.head.slice(0, 7)}</span>
          <span className="meta-files">
            {diff.files.length} file{diff.files.length === 1 ? '' : 's'}
          </span>
          <span>
            <span className="added">+{added}</span> <span className="removed">−{removed}</span>
          </span>
        </div>
      </div>
      {drawer ? (
        <button
          type="button"
          className="progress progress-button"
          aria-haspopup="dialog"
          aria-expanded={drawer.open}
          aria-label={`${progressText(index, total, finished)}. Open the route.`}
          onClick={drawer.onOpen}
        >
          <span>
            {progressText(index, total, finished)} <span aria-hidden="true">▾</span>
          </span>
          <ProgressTrack index={index} total={total} finished={finished} />
        </button>
      ) : (
        <div className="progress">
          <span>{progressText(index, total, finished)}</span>
          <ProgressTrack index={index} total={total} finished={finished} />
        </div>
      )}
      {/* On narrow windows the label collapses to its icon; screen readers still hear it. */}
      {posted ? (
        <a
          className="verdict-button posted"
          href={posted.url}
          target="_blank"
          rel="noreferrer"
          title={postedLabel(posted)}
        >
          <span aria-hidden="true">✓</span>{' '}
          <span className="verdict-button-label">{postedLabel(posted)}</span>
        </a>
      ) : (
        <button
          type="button"
          className="verdict-button"
          disabled
          title="Comes at the end of the tour"
        >
          <FlagIcon /> <span className="verdict-button-label">Verdict at the end</span>
        </button>
      )}
      <ThemeToggle />
    </header>
  );
}

/** Where the reader is. While stops are still being written, the total so far. */
function progressText(index: number, total: number, finished: boolean): string {
  if (total === 0) return 'Preparing the tour';
  return finished ? `Stop ${index + 1} of ${total}` : `Stop ${index + 1} of ${total} so far`;
}

function ProgressTrack({
  index,
  total,
  finished,
}: {
  index: number;
  total: number;
  finished: boolean;
}) {
  // Same size, no fill: until the route is finished, a fraction would be a guess.
  if (!finished) return <div className="progress-track" aria-hidden="true" />;
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={index + 1}
      aria-label="Tour progress"
    >
      <div className="progress-fill" style={{ width: `${((index + 1) / total) * 100}%` }} />
    </div>
  );
}

/** The verdict button's icon, shown alone when the window is too narrow for its label. */
function FlagIcon() {
  return (
    <svg
      className="verdict-button-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 14.5V2M3.5 2.5h8l-1.8 3 1.8 3h-8" />
    </svg>
  );
}

function Route({
  stops,
  index,
  onSelect,
  skips,
  onOpenSkip,
  tour,
  writing,
}: {
  stops: readonly StopView[];
  index: number;
  onSelect: (index: number) => void;
  skips: Ready['tour']['skips'];
  onOpenSkip: (path: string) => void;
  /** The finished tour, or null while it's still being written. */
  tour: Ready | null;
  writing: Working | null;
}) {
  const spent = tour?.costs.reduce((sum, c) => sum + c.costMicroUsd, 0) ?? 0;
  return (
    <div className="route">
      <h2 className="section-label">The route</h2>
      <ol className="stops">
        {stops.map((stop, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'upcoming';
          return (
            <li key={stop.id}>
              <button
                type="button"
                className={`stop-button ${state}`}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => onSelect(i)}
              >
                <span className="stop-number" aria-hidden="true">
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span>
                  <span className="stop-kind">
                    {KIND_LABELS[stop.kind]}
                    {stop.flags.map((flag) => (
                      <span key={flag} className="stop-flag">
                        · {flag}
                      </span>
                    ))}
                  </span>
                  <span className="stop-title">{inline(stop.title)}</span>
                </span>
              </button>
            </li>
          );
        })}
        {writing && <UpcomingStop stops={stops} writing={writing} />}
      </ol>

      <section className="skips" aria-label="Skipped">
        <h2 className="section-label">Skipped, with reasons{tour ? ` (${skips.length})` : ''}</h2>
        {!tour ? (
          <p className="empty-note">Listed once the whole tour is checked.</p>
        ) : skips.length === 0 ? (
          <p className="empty-note">Nothing skipped: every changed line is on the route.</p>
        ) : (
          <ul className="skip-list">
            {skips.map((skip) => (
              <li key={`${skip.path}${skip.hunk ?? ''}`}>
                <button type="button" className="skip-button" onClick={() => onOpenSkip(skip.path)}>
                  <span className="skip-path">
                    {skip.path}
                    {skip.hunk ? ' (one hunk)' : ''}
                  </span>
                  <span className="skip-reason">{inline(skip.reason)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {tour && tour.problems.length > 0 && (
        <details className="checks">
          <summary>
            {tour.problems.length} unresolved check{tour.problems.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {tour.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="cost-line">
        {!tour
          ? 'The guide is still writing. Its cost shows here when it finishes.'
          : tour.cached
            ? `Loaded from cache · no model calls (first written for ${formatUsd(spent)})`
            : `Tour written for ${formatUsd(spent)} · ${tour.attempts} attempt${tour.attempts === 1 ? '' : 's'} · ${tour.model}`}
      </p>
    </div>
  );
}

/** The route's next row while the guide writes: says what's happening, never how long it'll take. */
function UpcomingStop({ stops, writing }: { stops: readonly StopView[]; writing: Working }) {
  const step = writing.steps.find((s) => s.status === 'active')?.id;
  const verdictIn = stops.at(-1)?.kind === 'verdict_prompt';
  const label =
    writing.attempt > 1
      ? 'Fixing what the checker found'
      : step === 'checking' || verdictIn
        ? 'Checking the whole tour'
        : step === 'writing'
          ? `Writing stop ${Math.max(writing.writing, stops.length + 1)}`
          : 'Planning the route';
  return (
    <li className="upcoming-stop" aria-live="polite">
      <span className="upcoming-dot" aria-hidden="true" />
      <span>
        <span className="stop-kind">In progress</span>
        <span className="upcoming-title">{label}…</span>
      </span>
    </li>
  );
}

function Overview({
  snapshot,
  diff,
  onOpen,
}: {
  snapshot: ReviewSnapshot;
  diff: Diff;
  onOpen: (viewing: Viewing) => void;
}) {
  return (
    <div className="overview fade-in">
      <h3>What the PR says</h3>
      <p className="description">{snapshot.pr?.body.trim() || 'No description.'}</p>
      <h3>Files in this change</h3>
      <ul className="file-list">
        {diff.files.map((file) => {
          const lines = file.hunks.flatMap((h) => h.lines);
          const added = lines.filter((l) => l.kind === 'added').length;
          const removed = lines.filter((l) => l.kind === 'removed').length;
          return (
            <li key={file.path}>
              <button
                type="button"
                className="file-row"
                onClick={() => onOpen({ path: file.path, side: sideFor(diff, file.path) })}
              >
                <span className="mono">{file.path}</span>
                <span className="counts">
                  <span style={{ color: 'var(--added-mark)' }}>+{added}</span>{' '}
                  <span style={{ color: 'var(--removed-mark)' }}>−{removed}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Exchange = {
  id: string;
  question: string;
  answer: AnswerView | null;
  error: string | null;
  /** The guide's note when the code contradicts the author's answer. Usually never set. */
  correction: CorrectionView | null;
};

/** Who answered, and what it cost: the author's session, or the guide and why. */
function answerSource(answer: AnswerView): string {
  const known = formatUsd(answer.costs.reduce((sum, c) => sum + c.costMicroUsd, 0));
  const cost = answer.costIncomplete ? `${known}, plus a failed fork of unknown cost` : known;
  return answer.source === 'author_session'
    ? `Answered by the author's session, in a read-only copy · ${cost}`
    : `Answered by the guide, not the author (${lowerFirst(answer.whyNotAuthor)}) · ${cost}`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function Narration({
  stop,
  author,
  exchanges,
  onAsk,
  onOpenCite,
  activeAnchor,
  onAnchor,
  isLast,
  onNext,
  finished,
  waiting,
  verdict,
}: {
  stop: StopView;
  author: AuthorView;
  exchanges: readonly Exchange[];
  onAsk: (question: string) => void;
  onOpenCite: (cite: AnchorView) => void;
  activeAnchor: number;
  onAnchor: (index: number) => void;
  isLast: boolean;
  onNext: () => void;
  /** False while the rest of the tour is still being written and checked. */
  finished: boolean;
  /** What the next-stop button says while the next stop isn't ready yet. */
  waiting: string;
  /** The verdict form, on the verdict stop. */
  verdict: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const last = exchanges.at(-1);
  const pending = last !== undefined && last.answer === null && last.error === null;
  // A new question scrolls into view at the top, so its answer arrives below it and the
  // question box follows, as in a chat.
  const newest = useRef<HTMLParagraphElement>(null);
  const asked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the new question has rendered.
  useEffect(() => {
    if (!asked.current) return;
    asked.current = false;
    newest.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [exchanges.length]);
  const submit = () => {
    const question = draft.trim();
    if (!question || pending) return;
    asked.current = true;
    setDraft('');
    onAsk(question);
  };

  return (
    <div className="narration">
      <div className="narration-body fade-in">
        <div className="narration-kind">{KIND_LABELS[stop.kind]}</div>
        <h2 className="narration-title">{inline(stop.title)}</h2>
        <div className="narration-text">{paragraphs(stop.body)}</div>

        {stop.anchors.length > 0 && (
          <div className="chips">
            {stop.anchors.map((anchor, i) => (
              <button
                type="button"
                key={`${anchor.side}:${anchor.path}:${anchor.startLine}`}
                className="chip"
                aria-pressed={i === activeAnchor}
                onClick={() => onAnchor(i)}
                title={`${anchor.path} at ${anchor.side === 'new' ? 'head' : 'base'}`}
              >
                {chipLabel(anchor)}
              </button>
            ))}
          </div>
        )}

        {stop.flagNotes.map(({ flag, note }) => (
          <div key={flag} className={`callout ${flag}`} role="note">
            <div className="callout-label">
              {flag === 'danger' ? 'Possible danger' : 'Description and code differ'}
            </div>
            <p>{inline(note)}</p>
          </div>
        ))}

        {verdict}

        {!finished ? (
          <p className="waiting-note">Questions open once the whole tour is written and checked.</p>
        ) : (
          <div className="question">
            {exchanges.map((exchange, i) => (
              <div className="exchange fade-in" key={exchange.id}>
                <p
                  className="exchange-question"
                  ref={i === exchanges.length - 1 ? newest : undefined}
                >
                  {exchange.question}
                </p>
                {exchange.answer ? (
                  <>
                    <div className="exchange-answer">
                      <Markdown text={exchange.answer.text} />
                    </div>
                    <div className="exchange-source">{answerSource(exchange.answer)}</div>
                    {exchange.answer.source === 'author_session' && (
                      // Present before any note arrives, so a screen reader announces it.
                      <div aria-live="polite">
                        {exchange.correction && (
                          <Correction correction={exchange.correction} onOpenCite={onOpenCite} />
                        )}
                      </div>
                    )}
                  </>
                ) : exchange.error ? (
                  <div className="exchange-source" role="alert">
                    Couldn't answer: {exchange.error}
                  </div>
                ) : (
                  <div className="exchange-source" aria-live="polite">
                    {author?.found
                      ? "The author's session is thinking it over…"
                      : 'The guide is reading the code…'}
                  </div>
                )}
              </div>
            ))}
            <label
              htmlFor={`question-${stop.id}`}
              className={exchanges.length > 0 ? 'follow-up' : undefined}
            >
              {exchanges.length > 0 ? 'Ask a follow-up' : 'Your question'}
            </label>
            <textarea
              id={`question-${stop.id}`}
              value={draft}
              placeholder="Why is it built this way? What calls this?"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="question-actions">
              <span>
                <kbd>⌘</kbd> <kbd>Enter</kbd> to ask
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={submit}
                disabled={!draft.trim() || pending}
              >
                {pending ? 'Asking…' : author?.found ? 'Ask the author' : 'Ask the guide'}
              </button>
            </div>
          </div>
        )}
      </div>

      <footer className="narration-footer">
        <span className="batch-note">Pending batch · no changes yet</span>
        {!isLast ? (
          <button type="button" className="primary-button" onClick={onNext}>
            Next stop <span aria-hidden="true">→</span>
          </button>
        ) : !finished && stop.kind !== 'verdict_prompt' ? (
          <button type="button" className="primary-button" disabled>
            {waiting}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * The guide's note under an author answer the code contradicts. It says what the code does,
 * with the lines; it doesn't grade the answer.
 */
function Correction({
  correction,
  onOpenCite,
}: {
  correction: CorrectionView;
  onOpenCite: (cite: AnchorView) => void;
}) {
  const spent = correction.costs.reduce((sum, c) => sum + c.costMicroUsd, 0);
  return (
    <div className="callout correction fade-in" role="note">
      <div className="callout-label">From the code</div>
      <p>{inline(correction.text)}</p>
      <div className="chips">
        {correction.cites.map((cite) => (
          <button
            type="button"
            key={`${cite.path}:${cite.startLine}-${cite.endLine}`}
            className="chip"
            onClick={() => onOpenCite(cite)}
            title={`${cite.path} at head`}
          >
            {chipLabel(cite)}
          </button>
        ))}
      </div>
      <div className="correction-source">Noted by the guide, at head · {formatUsd(spent)}</div>
    </div>
  );
}

/** Plain paragraphs, with `backticks` shown as code. The guide's text is never parsed as HTML. */
function paragraphs(text: string): ReactNode {
  return text
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional.
      <p key={i}>{inline(p)}</p>
    ));
}

/** One line of the guide's text, with `backticks` shown as code. */
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/).map((part, j) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
      <code key={j}>{part.slice(1, -1)}</code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
      <Fragment key={j}>{part}</Fragment>
    ),
  );
}

function chipLabel(anchor: AnchorView): string {
  const name = anchor.path.split('/').at(-1) ?? anchor.path;
  const range =
    anchor.startLine === anchor.endLine
      ? `${anchor.startLine}`
      : `${anchor.startLine}–${anchor.endLine}`;
  return `${name} ${range}${anchor.side === 'old' ? ' (base)' : ''}`;
}

function formatUsd(microUsd: number): string {
  const usd = microUsd / 1e6;
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** Where to open a file: at head, unless the PR deleted it. */
function sideFor(diff: Diff, path: string): 'old' | 'new' {
  const file = diff.files.find((f) => f.path === path);
  const lines = file?.hunks.flatMap((h) => h.lines) ?? [];
  const deleted = lines.length > 0 && lines.every((l) => l.kind === 'removed');
  return deleted ? 'old' : 'new';
}

/** Changed line numbers per `side:path`: added lines at head, removed lines at base. */
function changedLines(diff: Diff): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  const add = (key: string, line: number) => {
    const set = map.get(key) ?? new Set<number>();
    set.add(line);
    map.set(key, set);
  };
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'added') add(`new:${file.path}`, line.newLine);
        else if (line.kind === 'removed') add(`old:${file.oldPath}`, line.oldLine);
      }
    }
  }
  return map;
}
