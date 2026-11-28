import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { JumpTo } from './definition-popover.tsx';

/** A lookup slower than this is likely building the index: the panel says so. */
const SLOW_MS = 1_200;

/**
 * Every line at head that uses a name, grouped by file with the PR's changed files first. Docked
 * under the code, so it stays while the reviewer opens one result after another; the trail's
 * back button returns from each. A non-modal <dialog>, so the page's arrow-key shortcuts leave
 * it alone: ↑ ↓ move between results, Enter opens one, Esc closes the panel.
 */
export function ReferencesPanel({
  name,
  current,
  onOpen,
  onClose,
}: {
  name: string;
  /** The place on screen, so the result open now is marked. */
  current: { path: string; line: number | null };
  onOpen: (to: JumpTo) => void;
  onClose: () => void;
}) {
  const found = useQuery({
    queryKey: ['references', name],
    queryFn: async () => {
      const res = await api.references.$get({ query: { symbol: name } });
      if (res.status === 200) return res.json();
      if (res.status === 503) throw new Error('The pull request is still loading. Try again soon.');
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `The server answered ${res.status}.`);
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const box = useRef<HTMLDialogElement>(null);
  const [slow, setSlow] = useState(false);
  const pending = found.isPending;
  useEffect(() => {
    if (!pending) return;
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  // Focus comes in with the panel, and onto the first result once there are some, so the
  // keyboard can go straight on.
  const data = found.data;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (data && data.files.length > 0) {
      if (!el.querySelector('.refs-line:focus'))
        el.querySelector<HTMLElement>('.refs-line')?.focus({ preventScroll: true });
    } else if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [data]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>('.refs-line') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const now = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : Math.max(0, Math.min(items.length - 1, now + (event.key === 'ArrowDown' ? 1 : -1)));
    items[next]?.focus();
    items[next]?.scrollIntoView({ block: 'nearest' });
  };

  const fileCount = data?.files.length ?? 0;
  const partial =
    data && (data.index.state === 'partial' || data.index.usesFiles < data.index.files);

  return (
    <dialog
      ref={box}
      open
      className="refs-panel"
      aria-label={`References to ${name}`}
      // The panel itself takes focus while there are no results to focus.
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="refs-header">
        <p className="refs-title">
          References to <code>{name}</code>
        </p>
        {data && (
          <span className="refs-count">
            {data.total.toLocaleString()} in {fileCount.toLocaleString()} file
            {fileCount === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          className="icon-button refs-close"
          aria-label="Close references"
          title="Close (Esc)"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="refs-body">
        {pending && (
          <p className="refs-note" role="status">
            {slow
              ? 'Still looking. The first lookup builds an index of the repository, which can take up to 20 seconds.'
              : `Finding references to ${name}…`}
          </p>
        )}
        {found.isError && (
          <div className="refs-note" role="alert">
            <p>{found.error.message}</p>
            <button type="button" className="secondary-button" onClick={() => found.refetch()}>
              Try again
            </button>
          </div>
        )}
        {data && data.files.length === 0 && (
          <p className="refs-note" role="status">
            No uses of <code>{name}</code> at the PR's head.
          </p>
        )}
        {data?.files.map((file) => (
          <section key={file.path} className="refs-file" aria-label={file.path}>
            <h3 className="refs-file-head">
              <bdi className="refs-path" title={file.path}>
                {file.path}
              </bdi>
              {file.changed && <span className="refs-tag">changed</span>}
              <span className="refs-file-count">{file.lines.length}</span>
            </h3>
            <ul className="refs-lines">
              {file.lines.map(({ line, text }) => {
                const here = current.path === file.path && current.line === line;
                return (
                  <li key={line}>
                    <button
                      type="button"
                      className="refs-line"
                      aria-current={here ? 'location' : undefined}
                      onClick={() => onOpen({ path: file.path, line, label: `use of ${name}` })}
                    >
                      <span className="refs-number">{line}</span>
                      <span className="refs-text">
                        <Marked text={text} name={name} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {data && (data.truncated || partial) && (
          <p className="refs-note">
            {data.truncated ? `Showing the first ${countShown(data.files)}. ` : ''}
            {partial ? 'The index covers part of the repository, so some uses may be missing.' : ''}
          </p>
        )}
      </div>
    </dialog>
  );
}

const countShown = (files: readonly { lines: readonly unknown[] }[]) =>
  files.reduce((sum, f) => sum + f.lines.length, 0).toLocaleString();

/** A line of code with each whole-word use of `name` marked. */
function Marked({ text, name }: { text: string; name: string }) {
  if (!text) return <> </>;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, 'gu');
  const parts: (string | { mark: string; at: number })[] = [];
  let last = 0;
  for (const match of text.matchAll(word)) {
    parts.push(text.slice(last, match.index));
    parts.push({ mark: match[0], at: match.index });
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line are positional.
          <span key={i}>{part}</span>
        ) : (
          <mark key={`m${part.at}`}>{part.mark}</mark>
        ),
      )}
    </>
  );
}
