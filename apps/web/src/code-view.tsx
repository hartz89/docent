import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, useEffect, useLayoutEffect, useRef } from 'react';
import { api } from './api.ts';
import { highlight, type Token } from './highlight.ts';

export type Range = { startLine: number; endLine: number };

type Props = {
  path: string;
  side: 'old' | 'new';
  /** Every range this stop cites in this file. */
  cited: readonly Range[];
  /** The range to bring into view, or null to show the top of the file. */
  focus: Range | null;
  /** Line numbers changed by the PR on this side: added at head, removed at base. */
  changed: ReadonlySet<number>;
  /**
   * Moves to the stop's next (1) or previous (-1) citation. Returns false when there is none,
   * and the arrow keys then scroll the file instead. Absent when no citation is in focus.
   */
  onStep: ((delta: 1 | -1) => boolean) | undefined;
};

/** Room left around a citation when ↑ ↓ reveal its edges. */
const REVEAL_PADDING = 48;

/** A read-only view of one file, with the PR's changes and the stop's citations marked. */
export function CodeView({ path, side, cited, focus, changed, onStep }: Props) {
  const file = useQuery({
    queryKey: ['file', side, path],
    queryFn: async () => {
      const res = await api.file.$get({ query: { path, side } });
      if (res.status !== 200) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `The server answered ${res.status}`);
      }
      const { text } = await res.json();
      return highlight(path, text);
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const scroller = useRef<HTMLDivElement>(null);
  const focusStart = focus?.startLine ?? null;
  const focusEnd = focus?.endLine ?? null;
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !file.data) return;
    if (focusStart === null || focusEnd === null) {
      box.scrollTop = 0;
      return;
    }
    const first = box.querySelector<HTMLElement>(`[data-line="${focusStart}"]`);
    const last = box.querySelector<HTMLElement>(`[data-line="${focusEnd}"]`) ?? first;
    if (!first || !last) return;
    const span = last.offsetTop + last.offsetHeight - first.offsetTop;
    // Center the cited range, or put its start a little below the top if it's taller than the view.
    const target =
      span < box.clientHeight * 0.8
        ? first.offsetTop - (box.clientHeight - span) / 2
        : first.offsetTop - 48;
    box.scrollTop = Math.max(0, target);
  }, [file.data, focusStart, focusEnd]);

  // ↓ reads on through the citation in focus while any of it is below the view; once its end is
  // in view (with some room), the next ↓ moves to the stop's next citation. ↑ mirrors that. Past
  // the first or last citation, or with no citation in focus, the arrows scroll the file.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const box = scroller.current;
      if (!box) return;
      event.preventDefault();
      const down = event.key === 'ArrowDown';
      const step = Math.round(box.clientHeight * 0.6);
      const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth';
      const first = focusStart === null ? null : lineAt(box, focusStart);
      const last = focusEnd === null ? null : (lineAt(box, focusEnd) ?? first);
      if (first && last) {
        if (down) {
          const want = last.offsetTop + last.offsetHeight + REVEAL_PADDING;
          if (want > box.scrollTop + box.clientHeight + 1) {
            box.scrollTo({
              top: Math.min(want - box.clientHeight, box.scrollTop + step),
              behavior,
            });
            return;
          }
        } else {
          const want = first.offsetTop - REVEAL_PADDING;
          if (want < box.scrollTop - 1) {
            box.scrollTo({ top: Math.max(want, box.scrollTop - step), behavior });
            return;
          }
        }
        // A held key reads on but doesn't race through the stop's citations.
        if (event.repeat) return;
        if (onStep?.(down ? 1 : -1)) return;
      }
      box.scrollBy({ top: down ? step : -step, behavior });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusStart, focusEnd, onStep]);

  const isCited = (line: number) => cited.some((r) => line >= r.startLine && line <= r.endLine);
  const changeClass = side === 'new' ? 'added' : 'removed';
  const changeMark = side === 'new' ? '+' : '−';

  return (
    <>
      <div className="code-scroll" ref={scroller}>
        {file.isPending && <p className="code-message">Opening {path}…</p>}
        {file.isError && (
          <p className="code-message" role="alert">
            Couldn't open {path}: {file.error.message}
          </p>
        )}
        {file.data && (
          <div className="code fade-in">
            {file.data.map((tokens, index) => {
              const line = index + 1;
              const isChanged = changed.has(line);
              const classes = ['line', isChanged ? changeClass : '', isCited(line) ? 'cited' : '']
                .filter(Boolean)
                .join(' ');
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional by nature.
                <div key={index} className={classes} data-line={line}>
                  <span className="line-number">{line}</span>
                  <span className="line-mark">{isChanged ? changeMark : ''}</span>
                  <span className="line-text">
                    {tokens.map((token, t) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional too.
                      <span key={t} style={tokenStyle(token)}>
                        {token.text}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="legend" aria-hidden="true">
        <span>
          <i className={`swatch ${changeClass}`} />
          {side === 'new' ? 'Added in this PR' : 'Removed by this PR'}
        </span>
        <span>
          <i className="swatch cited" />
          Cited by this stop
        </span>
        <span>
          <kbd>←</kbd> <kbd>→</kbd> stops · <kbd>↑</kbd> <kbd>↓</kbd> read on
        </span>
      </div>
    </>
  );
}

/** Both themes' colors ride along as CSS variables; styles.css picks the one for the page's theme. */
function tokenStyle({ dark, light }: Token): CSSProperties | undefined {
  if (!dark && !light) return undefined;
  return { '--token-dark': dark, '--token-light': light } as CSSProperties;
}

const lineAt = (box: HTMLElement, line: number) =>
  box.querySelector<HTMLElement>(`[data-line="${line}"]`);
