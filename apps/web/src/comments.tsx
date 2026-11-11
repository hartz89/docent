// The reviewer's line comments while they're drafts: kept in this browser per PR, shown under
// their lines, gathered in the batch, and sent with the verdict. The server decides what GitHub
// receives; this module only shows where each comment will land.
import { diffPosition } from '@docent/core';
import type { PrInfo, ReviewSnapshot } from '@docent/server';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LineTokens, useFile } from './code-view.tsx';

type Diff = NonNullable<ReviewSnapshot['diff']>;
type Side = 'old' | 'new';

/** A comment not yet posted, on a line of a file at the commit it was written against. */
export type Draft = {
  id: string;
  path: string;
  side: Side;
  line: number;
  body: string;
  /** The PR head it was written at. A draft from an older head is stale and isn't sent. */
  head: string;
  /** The stop it was written at, so the batch can take the reviewer back there. */
  stopId: string;
};

/** The comment being written: a new one on a line, or an edit of a saved draft. */
export type Composing = {
  path: string;
  side: Side;
  line: number;
  draftId: string | null;
  text: string;
};

const storageKey = (pr: PrInfo) => `docent:drafts:${pr.repo}#${pr.number}`;

function load(key: string): Draft[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(saved) ? saved.filter(isDraft) : [];
  } catch {
    // Storage can be blocked or hold something else; then drafts last until the tab closes.
    return [];
  }
}

function isDraft(value: unknown): value is Draft {
  const d = value as Partial<Draft> | null;
  return (
    typeof d?.id === 'string' &&
    typeof d.path === 'string' &&
    (d.side === 'old' || d.side === 'new') &&
    typeof d.line === 'number' &&
    typeof d.body === 'string' &&
    typeof d.head === 'string' &&
    typeof d.stopId === 'string'
  );
}

/**
 * This PR's drafts, saved in the browser so they survive a reload. `current` were written at the
 * head this tour covers; `stale` at an older one, so their lines may have moved.
 */
export function useDrafts(pr: PrInfo) {
  const key = storageKey(pr);
  const [drafts, setDrafts] = useState<Draft[]>(() => load(key));
  useEffect(() => {
    try {
      if (drafts.length) localStorage.setItem(key, JSON.stringify(drafts));
      else localStorage.removeItem(key);
    } catch {}
  }, [key, drafts]);

  const save = useCallback((draft: Draft) => {
    setDrafts((all) =>
      all.some((d) => d.id === draft.id)
        ? all.map((d) => (d.id === draft.id ? draft : d))
        : [...all, draft],
    );
  }, []);
  const remove = useCallback((ids: readonly string[]) => {
    setDrafts((all) => all.filter((d) => !ids.includes(d.id)));
  }, []);

  // In reading order: by file, then base before head, then line.
  const sorted = [...drafts].sort(
    (a, b) => a.path.localeCompare(b.path) || a.side.localeCompare(b.side) || a.line - b.line,
  );
  return {
    current: sorted.filter((d) => d.head === pr.head),
    stale: sorted.filter((d) => d.head !== pr.head),
    save,
    remove,
  };
}

/** Whether a draft lands on its line on GitHub, or in the review body. */
export function landsOnDiff(diff: Diff, draft: Pick<Draft, 'path' | 'side' | 'line'>): boolean {
  return diffPosition(diff, draft) !== null;
}

export const whereLabel = (d: Pick<Draft, 'path' | 'side' | 'line'>) =>
  `${d.path}:${d.line}${d.side === 'old' ? ' (base)' : ''}`;

const fileName = (path: string) => path.split('/').at(-1) ?? path;

/** The comment box under a line. ⌘↵ adds it to the batch; Esc closes it. */
export function Composer({
  composing,
  onText,
  onSave,
  onCancel,
}: {
  composing: Composing;
  onText: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  const editing = composing.draftId !== null;
  const ready = composing.text.trim() !== '';
  const id = `composer-${composing.side}-${composing.line}`;
  return (
    <div className="thread draft" ref={box}>
      <div className="thread-bar">
        <span className="draft-chip">Draft · not posted</span>
        <label htmlFor={id}>Your comment on line {composing.line}</label>
        <span className="grow" />
        <span>{editing ? 'In the batch' : 'Adds to the batch'}</span>
      </div>
      <div className="composer">
        <textarea
          id={id}
          // biome-ignore lint/a11y/noAutofocus: the reviewer just asked to write here.
          autoFocus
          value={composing.text}
          placeholder="What should the author know about this line?"
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (ready) onSave();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        <div className="composer-row">
          <span>
            <kbd>⌘</kbd> <kbd>Enter</kbd> {editing ? 'to save' : 'adds to the batch'}
          </span>
          <span className="grow" />
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={!ready} onClick={onSave}>
            {editing ? 'Save' : 'Add to batch'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A saved draft under its line: still editable and removable until it's posted. */
export function DraftCard({
  draft,
  onEdit,
  onRemove,
}: {
  draft: Draft;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="thread draft">
      <div className="thread-bar">
        <span className="draft-chip">Draft · not posted</span>
        <span>Your comment on line {draft.line}</span>
        <span className="grow" />
        <button type="button" className="text-button" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="text-button" onClick={onRemove}>
          Remove
        </button>
      </div>
      <p className="thread-body">{draft.body}</p>
    </div>
  );
}

/** The pending batch, at the foot of the guide. Each comment takes you back to its line. */
export function BatchTray({
  current,
  stale,
  diff,
  onJump,
}: {
  current: readonly Draft[];
  stale: readonly Draft[];
  diff: Diff;
  onJump: (draft: Draft) => void;
}) {
  const [open, setOpen] = useState(true);
  const inBody = current.filter((d) => !landsOnDiff(diff, d)).length;
  const parts = [
    current.length - inBody > 0 ? `${current.length - inBody} on diff lines` : '',
    inBody > 0 ? `${inBody} in the summary` : '',
    stale.length > 0 ? `${stale.length} out of date` : '',
  ].filter(Boolean);
  const all = [...current, ...stale];
  return (
    <section className="tray" aria-label="Your batch">
      <div className="tray-head">
        <span className="count">{current.length}</span>
        <b>Your batch</b>
        <span className="tray-sub">{parts.join(' · ')}</span>
        <span className="grow" />
        <button
          type="button"
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <ul className="tray-list">
          {all.map((draft) => {
            const isStale = !current.includes(draft);
            return (
              <li key={draft.id}>
                <button type="button" className="tray-item" onClick={() => onJump(draft)}>
                  <span className="tray-where">
                    {fileName(draft.path)}:{draft.line}
                    {draft.side === 'old' ? ' (base)' : ''}
                  </span>
                  <span className="tray-what">{draft.body}</span>
                  <span className="tray-tag">
                    {isStale ? 'out of date' : landsOnDiff(diff, draft) ? 'line' : 'summary'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The verdict stop's middle pane: every comment in the batch with its line, saying where it will
 * land on GitHub. Stale ones say so, and are only sent once the reviewer keeps them.
 */
export function ReviewList({
  current,
  stale,
  diff,
  head,
  composing,
  onEdit,
  onRemove,
  onKeep,
  composer,
}: {
  current: readonly Draft[];
  stale: readonly Draft[];
  diff: Diff;
  head: string;
  composing: Composing | null;
  onEdit: (draft: Draft) => void;
  onRemove: (draft: Draft) => void;
  onKeep: (draft: Draft) => void;
  composer: ReactNode;
}) {
  const count = current.length;
  return (
    <div className="review-list fade-in">
      <h3>Your review</h3>
      <p className="review-list-sub">
        {count === 0
          ? 'No comments wait in the batch.'
          : `${count} comment${count === 1 ? '' : 's'} wait${count === 1 ? 's' : ''} in the batch. Nothing is posted until you send it.`}
      </p>
      {[...current, ...stale].map((draft) => {
        const isStale = !current.includes(draft);
        const editing = composing?.draftId === draft.id;
        return (
          <article key={draft.id} className={`review-item${isStale ? ' stale' : ''}`}>
            <header className="review-item-head">
              <span className="mono review-item-where">{whereLabel(draft)}</span>
              <span className="review-item-tag">
                {isStale
                  ? `written at ${draft.head.slice(0, 7)} · the PR has moved to ${head.slice(0, 7)}`
                  : landsOnDiff(diff, draft)
                    ? 'on the diff line'
                    : 'outside the diff · goes in the summary'}
              </span>
              <span className="grow" />
              {isStale ? (
                <button type="button" className="text-button" onClick={() => onKeep(draft)}>
                  Keep at this line
                </button>
              ) : (
                <button type="button" className="text-button" onClick={() => onEdit(draft)}>
                  Edit
                </button>
              )}
              <button type="button" className="text-button" onClick={() => onRemove(draft)}>
                Remove
              </button>
            </header>
            <LineSnippet path={draft.path} side={draft.side} line={draft.line} />
            {editing ? composer : <p className="thread-body">{draft.body}</p>}
          </article>
        );
      })}
    </div>
  );
}

/** One line of code, as the code view shows it. */
function LineSnippet({ path, side, line }: { path: string; side: Side; line: number }) {
  const file = useFile(path, side);
  const tokens = file.data?.[line - 1];
  return (
    <div className="code review-item-code">
      <div className="line">
        <span className="line-number">{line}</span>
        <span className="line-mark" />
        <span className="line-text">
          {tokens ? (
            <LineTokens tokens={tokens} />
          ) : file.isError ? (
            <span className="snippet-missing">Not in this commit</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
