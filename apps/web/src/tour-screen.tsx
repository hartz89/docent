import type {
  AnchorView,
  CostRecord,
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
import { Markdown } from './markdown.tsx';
import type { Ready } from './review-page.tsx';
import { postedLabel, VerdictForm } from './verdict.tsx';

type Props = { snapshot: ReviewSnapshot; tour: Ready };
type Diff = NonNullable<ReviewSnapshot['diff']>;
type Viewing = { path: string; side: 'old' | 'new' };

const KIND_LABELS: Record<StopView['kind'], string> = {
  intent: 'Intent',
  map: 'Map',
  core_change: 'Core change',
  edge: 'Edge',
  verdict_prompt: 'Your verdict',
};

export function TourScreen({ snapshot, tour }: Props) {
  const { stops, skips } = tour.tour;
  const [index, setIndex] = useState(0);
  const [anchorIndex, setAnchorIndex] = useState(0);
  // A file opened from the skip list or the overview, in place of the stop's citation.
  const [viewing, setViewing] = useState<Viewing | null>(null);
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
      [stopId]: [...(all[stopId] ?? []), { id, question, answer: null, error: null }],
    }));
    try {
      const res = await api.questions.$post({ json: { stopId, question } });
      const body = await res.json();
      if ('answer' in body) settle({ answer: body.answer });
      else settle({ error: body.error });
    } catch (error) {
      settle({ error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const stop = stops[index];
  // The guide column outlives each stop, so it would keep the last stop's scroll position.
  // A stop seen for the first time opens at the top; a revisited stop opens where it was left.
  const guide = useRef<HTMLElement>(null);
  const scrollByStop = useRef(new Map<string, number>());
  const go = useCallback(
    (next: number) => {
      if (stop && guide.current) scrollByStop.current.set(stop.id, guide.current.scrollTop);
      setIndex(Math.max(0, Math.min(stops.length - 1, next)));
      setAnchorIndex(0);
      setViewing(null);
    },
    [stop, stops.length],
  );
  const stopId = stop?.id;
  useLayoutEffect(() => {
    if (guide.current && stopId) guide.current.scrollTop = scrollByStop.current.get(stopId) ?? 0;
  }, [stopId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
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

  const diff = snapshot.diff as Diff;
  const changes = useMemo(() => changedLines(diff), [diff]);
  if (!stop || !snapshot.pr) return null;

  const anchor = stop.anchors[anchorIndex] ?? null;
  const shown: Viewing | null =
    viewing ?? (anchor ? { path: anchor.path, side: anchor.side } : null);
  const cited = shown
    ? stop.anchors.filter((a) => a.path === shown.path && a.side === shown.side)
    : [];

  return (
    <div className="app">
      <TopBar snapshot={snapshot} diff={diff} index={index} total={stops.length} posted={posted} />
      <div className="columns">
        <nav className="column" aria-label="The route">
          <Route
            stops={stops}
            index={index}
            onSelect={go}
            skips={skips}
            onOpenSkip={(path) => setViewing({ path, side: sideFor(diff, path) })}
            tour={tour}
          />
        </nav>
        <section className="column code-column" aria-label="Code">
          {shown ? (
            <>
              <div className="code-header">
                <span className="code-path">{shown.path}</span>
                <span className="code-range">
                  {viewing
                    ? 'opened from the route'
                    : anchor
                      ? `lines ${anchor.startLine}–${anchor.endLine} · cited by this stop`
                      : ''}
                </span>
                <span className="code-side">{shown.side === 'new' ? 'head' : 'base'}</span>
              </div>
              <CodeView
                path={shown.path}
                side={shown.side}
                cited={viewing ? [] : cited}
                focus={viewing ? null : anchor}
                changed={changes.get(`${shown.side}:${shown.path}`) ?? new Set()}
              />
            </>
          ) : (
            <Overview snapshot={snapshot} diff={diff} onOpen={setViewing} />
          )}
        </section>
        <aside className="column" aria-label="The guide" ref={guide}>
          <Narration
            key={stop.id}
            stop={stop}
            exchanges={threads[stop.id] ?? []}
            onAsk={(question) => void ask(stop.id, question)}
            activeAnchor={viewing ? -1 : anchorIndex}
            onAnchor={(i) => {
              setAnchorIndex(i);
              setViewing(null);
            }}
            isLast={index === stops.length - 1}
            onNext={() => go(index + 1)}
            verdict={
              stop.kind === 'verdict_prompt' ? (
                <VerdictForm pr={snapshot.pr} posted={posted} onPosted={setPosted} />
              ) : null
            }
          />
        </aside>
      </div>
    </div>
  );
}

function TopBar({
  snapshot,
  diff,
  index,
  total,
  posted,
}: {
  snapshot: ReviewSnapshot;
  diff: Diff;
  index: number;
  total: number;
  posted: PostedReview | null;
}) {
  const pr = snapshot.pr;
  const lines = diff.files.flatMap((f) => f.hunks.flatMap((h) => h.lines));
  const added = lines.filter((l) => l.kind === 'added').length;
  const removed = lines.filter((l) => l.kind === 'removed').length;
  return (
    <header className="topbar">
      <span className="brand">Docent</span>
      <div className="pr-heading">
        <h1 className="pr-title" title={pr?.title}>
          {pr?.title}
        </h1>
        <div className="pr-meta">
          <span>{pr?.repo}</span>
          <a
            href={pr?.url}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'inherit', textDecoration: 'none' }}
          >
            #{pr?.number}
          </a>
          <span className="mono">{pr?.head.slice(0, 7)}</span>
          <span>
            {diff.files.length} file{diff.files.length === 1 ? '' : 's'}
          </span>
          <span>
            <span className="added">+{added}</span> <span className="removed">−{removed}</span>
          </span>
        </div>
      </div>
      <div className="progress">
        <span>
          Stop {index + 1} of {total}
        </span>
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
      </div>
      {posted ? (
        <a className="verdict-button posted" href={posted.url} target="_blank" rel="noreferrer">
          <span aria-hidden="true">✓</span> {postedLabel(posted)}
        </a>
      ) : (
        <button
          type="button"
          className="verdict-button"
          disabled
          title="Comes at the end of the tour"
        >
          Verdict at the end
        </button>
      )}
    </header>
  );
}

function Route({
  stops,
  index,
  onSelect,
  skips,
  onOpenSkip,
  tour,
}: {
  stops: readonly StopView[];
  index: number;
  onSelect: (index: number) => void;
  skips: Ready['tour']['skips'];
  onOpenSkip: (path: string) => void;
  tour: Ready;
}) {
  const spent = tour.costs.reduce((sum, c) => sum + c.costMicroUsd, 0);
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
      </ol>

      <section className="skips" aria-label="Skipped">
        <h2 className="section-label">Skipped, with reasons ({skips.length})</h2>
        {skips.length === 0 ? (
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

      {tour.problems.length > 0 && (
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
        {tour.cached
          ? `Loaded from cache · no model calls (first written for ${formatUsd(spent)})`
          : `Tour written for ${formatUsd(spent)} · ${tour.attempts} attempt${tour.attempts === 1 ? '' : 's'} · ${tour.model}`}
      </p>
    </div>
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
  answer: { text: string; cost: CostRecord } | null;
  error: string | null;
};

function Narration({
  stop,
  exchanges,
  onAsk,
  activeAnchor,
  onAnchor,
  isLast,
  onNext,
  verdict,
}: {
  stop: StopView;
  exchanges: readonly Exchange[];
  onAsk: (question: string) => void;
  activeAnchor: number;
  onAnchor: (index: number) => void;
  isLast: boolean;
  onNext: () => void;
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
                  <div className="exchange-source">
                    Answered by the guide, not the author ·{' '}
                    {formatUsd(exchange.answer.cost.costMicroUsd)}
                  </div>
                </>
              ) : exchange.error ? (
                <div className="exchange-source" role="alert">
                  Couldn't answer: {exchange.error}
                </div>
              ) : (
                <div className="exchange-source" aria-live="polite">
                  The guide is reading the code…
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
              {pending ? 'Asking…' : 'Ask the guide'}
            </button>
          </div>
        </div>
      </div>

      <footer className="narration-footer">
        <span className="batch-note">Pending batch · no changes yet</span>
        {!isLast && (
          <button type="button" className="primary-button" onClick={onNext}>
            Next stop <span aria-hidden="true">→</span>
          </button>
        )}
      </footer>
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
