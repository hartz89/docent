import type {
  AnchorView,
  AnswerView,
  AuthorView,
  PostedReview,
  PrInfo,
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
import {
  BatchTray,
  Composer,
  type Composing,
  type Draft,
  DraftCard,
  ReviewList,
  useDrafts,
} from './comments.tsx';
import { Markdown } from './markdown.tsx';
import type { Ready } from './review-page.tsx';
import { ThemeToggle } from './theme.tsx';
import { postedLabel, VerdictForm } from './verdict.tsx';

type Props = { snapshot: ReviewSnapshot; tour: Ready };
type Diff = NonNullable<ReviewSnapshot['diff']>;
/** A file opened in place of the stop's citation, scrolled to `line` when one is given. */
type Viewing = { path: string; side: 'old' | 'new'; line?: number };

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
  // At the verdict stop the middle pane lists the batch, until a citation is chosen.
  const [verdictCode, setVerdictCode] = useState(false);
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
      setVerdictCode(false);
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

  // Line comments: saved drafts per PR, and the one being written.
  const pr = snapshot.pr as PrInfo;
  const drafts = useDrafts(pr);
  const [composing, setComposing] = useState<Composing | null>(null);
  const verdictIndex = stops.findIndex((s) => s.kind === 'verdict_prompt');
  const saveComposing = () => {
    if (!composing || !stop) return;
    const body = composing.text.trim();
    if (!body) return;
    const existing = [...drafts.current, ...drafts.stale].find((d) => d.id === composing.draftId);
    drafts.save({
      id: existing?.id ?? crypto.randomUUID(),
      path: composing.path,
      side: composing.side,
      line: composing.line,
      body,
      head: pr.head,
      stopId: existing?.stopId ?? stop.id,
    });
    setComposing(null);
  };
  const editDraft = (draft: Draft) =>
    setComposing({
      path: draft.path,
      side: draft.side,
      line: draft.line,
      draftId: draft.id,
      text: draft.body,
    });
  const removeDraft = (draft: Draft) => {
    drafts.remove([draft.id]);
    if (composing?.draftId === draft.id) setComposing(null);
  };
  /** Back to a comment's line: at the stop that cites it, or opened from the stop it was written at. */
  const jumpTo = (draft: Draft) => {
    const covers = (a: AnchorView) =>
      a.path === draft.path &&
      a.side === draft.side &&
      draft.line >= a.startLine &&
      draft.line <= a.endLine;
    const written = stops.findIndex((s) => s.id === draft.stopId);
    const candidates = [written, ...stops.keys()].filter((i) => i >= 0);
    const at = candidates.find((i) => stops[i]?.anchors.some(covers));
    if (at !== undefined) {
      go(at);
      setAnchorIndex(stops[at]?.anchors.findIndex(covers) ?? 0);
      setVerdictCode(true);
    } else {
      go(written >= 0 && written !== verdictIndex ? written : index);
      setViewing({ path: draft.path, side: draft.side, line: draft.line });
    }
  };
  /** Opens a comment on a line, unless one with text is already open: that one keeps its words. */
  const openComposer = (at: { path: string; side: 'old' | 'new' }, line: number) => {
    if (composing?.text.trim()) {
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
      return;
    }
    setComposing({ path: at.path, side: at.side, line, draftId: null, text: '' });
  };
  const composer = composing && (
    <Composer
      composing={composing}
      onText={(text) => setComposing({ ...composing, text })}
      onSave={saveComposing}
      onCancel={() => setComposing(null)}
    />
  );

  if (!stop || !snapshot.pr) return null;

  const anchor = stop.anchors[anchorIndex] ?? null;
  const shown: Viewing | null =
    viewing ?? (anchor ? { path: anchor.path, side: anchor.side } : null);
  const cited = shown
    ? stop.anchors.filter((a) => a.path === shown.path && a.side === shown.side)
    : [];
  const focus = viewing
    ? viewing.line
      ? { startLine: viewing.line, endLine: viewing.line }
      : null
    : anchor;
  const isVerdict = stop.kind === 'verdict_prompt';
  const commenting = !posted && shown !== null;
  const onThisFile = (d: { path: string; side: string }) =>
    shown !== null && d.path === shown.path && d.side === shown.side;
  const below = (line: number) => {
    const here = drafts.current.filter((d) => onThisFile(d) && d.line === line);
    const composingHere =
      composing && onThisFile(composing) && composing.line === line ? composing : null;
    if (here.length === 0 && !composingHere) return null;
    return (
      <div className="line-thread">
        {here.map((draft) =>
          composingHere?.draftId === draft.id ? (
            <Fragment key={draft.id}>{composer}</Fragment>
          ) : (
            <DraftCard
              key={draft.id}
              draft={draft}
              onEdit={() => editDraft(draft)}
              onRemove={() => removeDraft(draft)}
            />
          ),
        )}
        {composingHere && composingHere.draftId === null && composer}
      </div>
    );
  };
  const hasDrafts = drafts.current.length + drafts.stale.length > 0;
  // A comment being written, or an edit not yet saved: what's on screen isn't what would post.
  const editing = [...drafts.current, ...drafts.stale].find((d) => d.id === composing?.draftId);
  const hasUnsaved =
    composing !== null &&
    (editing ? composing.text.trim() !== editing.body : composing.text.trim() !== '');
  const listsBatch = isVerdict && hasDrafts && !posted && !viewing && !verdictCode;

  return (
    <div className="app">
      <TopBar
        snapshot={snapshot}
        diff={diff}
        index={index}
        total={stops.length}
        posted={posted}
        pending={drafts.current.length}
        onOpenBatch={verdictIndex >= 0 ? () => go(verdictIndex) : undefined}
      />
      <div className="columns">
        <nav className="column" aria-label="The route">
          <Route
            stops={stops}
            index={index}
            onSelect={go}
            commentsByStop={countBy(drafts.current, (d) => d.stopId)}
            skips={skips}
            onOpenSkip={(path) => setViewing({ path, side: sideFor(diff, path) })}
            tour={tour}
          />
        </nav>
        <section className="column code-column" aria-label="Code">
          {listsBatch ? (
            <ReviewList
              current={drafts.current}
              stale={drafts.stale}
              diff={diff}
              head={pr.head}
              composing={composing}
              onEdit={editDraft}
              onRemove={removeDraft}
              onKeep={(draft) => drafts.save({ ...draft, head: pr.head })}
              composer={composer}
            />
          ) : shown ? (
            <>
              <div className="code-header">
                {isVerdict && hasDrafts && !posted && (
                  <button
                    type="button"
                    className="text-button back-to-review"
                    onClick={() => {
                      setViewing(null);
                      setVerdictCode(false);
                    }}
                  >
                    <span aria-hidden="true">←</span> Your review
                  </button>
                )}
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
                focus={focus}
                changed={changes.get(`${shown.side}:${shown.path}`) ?? new Set()}
                onStep={viewing ? undefined : stepAnchor}
                onComment={commenting ? (line) => openComposer(shown, line) : undefined}
                below={commenting ? below : undefined}
                commentLine={composing && onThisFile(composing) ? composing.line : null}
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
            author={snapshot.author}
            exchanges={threads[stop.id] ?? []}
            onAsk={(question) => void ask(stop.id, question)}
            activeAnchor={viewing || listsBatch ? -1 : anchorIndex}
            onAnchor={(i) => {
              setAnchorIndex(i);
              setViewing(null);
              setVerdictCode(true);
            }}
            isLast={index === stops.length - 1}
            onNext={() => go(index + 1)}
            hasComments={hasDrafts || posted !== null}
            tray={
              !posted && !isVerdict && hasDrafts ? (
                <BatchTray
                  current={drafts.current}
                  stale={drafts.stale}
                  diff={diff}
                  onJump={jumpTo}
                />
              ) : null
            }
            verdict={
              isVerdict ? (
                <VerdictForm
                  pr={snapshot.pr}
                  diff={diff}
                  comments={drafts.current}
                  stale={drafts.stale.length}
                  unsaved={hasUnsaved}
                  posted={posted}
                  onPosted={(review, sent) => {
                    setPosted(review);
                    drafts.remove(sent.map((d) => d.id));
                    setComposing(null);
                  }}
                />
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
  pending,
  onOpenBatch,
}: {
  snapshot: ReviewSnapshot;
  diff: Diff;
  index: number;
  total: number;
  posted: PostedReview | null;
  /** Comments in the batch, not yet posted. */
  pending: number;
  onOpenBatch: (() => void) | undefined;
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
      {!posted && pending > 0 && (
        <button
          type="button"
          className="batch-pill"
          onClick={onOpenBatch}
          title="Your batch: nothing is posted until you send your verdict"
        >
          <span className="count">{pending}</span> not posted
        </button>
      )}
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
      <ThemeToggle />
    </header>
  );
}

function Route({
  stops,
  index,
  onSelect,
  commentsByStop,
  skips,
  onOpenSkip,
  tour,
}: {
  stops: readonly StopView[];
  index: number;
  onSelect: (index: number) => void;
  /** How many comments in the batch were written at each stop. */
  commentsByStop: ReadonlyMap<string, number>;
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
                {commentsByStop.has(stop.id) && (
                  <span className="stop-comments">
                    {commentsByStop.get(stop.id)}
                    <span className="sr-only"> comments</span>
                  </span>
                )}
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
  answer: AnswerView | null;
  error: string | null;
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
  activeAnchor,
  onAnchor,
  isLast,
  onNext,
  tray,
  hasComments,
  verdict,
}: {
  stop: StopView;
  author: AuthorView;
  exchanges: readonly Exchange[];
  onAsk: (question: string) => void;
  activeAnchor: number;
  onAnchor: (index: number) => void;
  isLast: boolean;
  onNext: () => void;
  /** The pending batch, when it holds any comments. */
  tray: ReactNode;
  /** The reviewer has comments, or has posted: no need for the how-to note. */
  hasComments: boolean;
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
                  <div className="exchange-source">{answerSource(exchange.answer)}</div>
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
      </div>

      <footer className="narration-footer">
        {tray}
        <div className="narration-nav">
          <span className="batch-note">
            {hasComments ? '' : 'No comments yet · click + beside a line'}
          </span>
          {!isLast && (
            <button type="button" className="primary-button" onClick={onNext}>
              Next stop <span aria-hidden="true">→</span>
            </button>
          )}
        </div>
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

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
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
