import { useQuery } from '@tanstack/react-query';
import { useLayoutEffect, useRef } from 'react';
import { api } from './api.ts';
import { highlight } from './highlight.ts';

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
};

/** A read-only view of one file, with the PR's changes and the stop's citations marked. */
export function CodeView({ path, side, cited, focus, changed }: Props) {
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
                      <span key={t} style={token.color ? { color: token.color } : undefined}>
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
          <kbd>←</kbd> <kbd>→</kbd> move between stops
        </span>
      </div>
    </>
  );
}
