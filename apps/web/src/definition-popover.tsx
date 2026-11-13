import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, fileTextQuery } from './api.ts';
import type { JumpTarget } from './jump.ts';

/** Where a jump goes: a file, at a line when the jump found one. */
export type JumpTo = { path: string; line?: number; label: string };

type Candidate = { path: string; line: number; rank: 'same_file' | 'import' | 'repo' };

/** What a lookup found, short of one place to go. */
export type Found =
  | { kind: 'loading'; name: string }
  | {
      kind: 'candidates';
      name: string;
      candidates: readonly Candidate[];
      truncated: boolean;
      partial: boolean;
    }
  | { kind: 'message'; text: string };

/**
 * Looks a target up. One definition, or an import that names a repo file, comes back as a place
 * to go. Anything else (several candidates, none, an error) comes back as something to show.
 */
export async function lookUp(
  target: JumpTarget,
  from: { path: string; side: 'old' | 'new'; line: number },
): Promise<JumpTo | Found> {
  try {
    if (target.kind === 'import') {
      const res = await api.import.$get({ query: { from: from.path, spec: target.spec } });
      if (res.status !== 200) return { kind: 'message', text: await failure(res) };
      const { path } = await res.json();
      if (path) return { path, label: `imported as '${target.spec}'` };
      return {
        kind: 'message',
        text: `'${target.spec}' doesn't name a file in this repo. It may be a package.`,
      };
    }
    // The index is of the PR's head, so a line at base says nothing about where to look first.
    const query =
      from.side === 'new'
        ? { symbol: target.name, from: from.path, line: String(from.line) }
        : { symbol: target.name };
    const res = await api.definition.$get({ query });
    if (res.status !== 200) return { kind: 'message', text: await failure(res) };
    const { candidates, truncated, index } = await res.json();
    const partial = index.state === 'partial';
    const only = candidates[0];
    if (candidates.length === 1 && only && !truncated) {
      return { path: only.path, line: only.line, label: `definition of ${target.name}` };
    }
    return { kind: 'candidates', name: target.name, candidates, truncated, partial };
  } catch (error) {
    return { kind: 'message', text: error instanceof Error ? error.message : String(error) };
  }
}

async function failure(res: Response): Promise<string> {
  if (res.status === 503) return 'The symbol index is still being built. Try again in a moment.';
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `The server answered ${res.status}.`;
}

const RANK_LABELS: Record<Candidate['rank'], string> = {
  same_file: 'this file',
  import: 'imported',
  repo: 'elsewhere',
};

/**
 * The candidates for an ambiguous jump, in the server's order, beside the name that was clicked.
 * A non-modal <dialog>, so the page's arrow-key shortcuts leave it alone. Esc or a click outside
 * closes it; focus goes back where it was.
 */
export function DefinitionPopover({
  found,
  at,
  onPick,
  onClose,
}: {
  found: Found;
  /** The clicked name's box, in viewport coordinates. */
  at: { left: number; top: number; bottom: number };
  onPick: (to: JumpTo) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDialogElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Below the name if it fits, above it if not; never off the side of the window. Measured again
  // when the content changes size, from "Looking up" to the list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: found changes the popover's size.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
    const below = at.bottom + 4;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, at.top - height - 4);
    setPlace({ left, top });
  }, [at, found]);

  // Focus the first candidate once there are some. The opener gets focus back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus({ preventScroll: true });
  }, []);
  const hasCandidates = found.kind === 'candidates' && found.candidates.length > 0;
  useEffect(() => {
    if (hasCandidates) box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [hasCandidates]);

  useEffect(() => {
    // Capture, on window: this runs before the page's own Esc handler, and stops it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [...(box.current?.querySelectorAll<HTMLElement>('button') ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const now = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'ArrowDown' ? now + 1 : now - 1;
      items[(next + items.length) % items.length]?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [onClose]);

  return (
    <dialog
      ref={box}
      open
      className={`jump-popover${found.kind === 'loading' ? ' loading' : ''}`}
      aria-label={
        found.kind === 'message' ? 'Jump to definition' : `Definitions of ${nameOf(found)}`
      }
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
    >
      {found.kind === 'loading' && <p className="jump-note">Looking up {found.name}…</p>}
      {found.kind === 'message' && (
        <p className="jump-note" role="status">
          {found.text}
        </p>
      )}
      {found.kind === 'candidates' && (
        <>
          <p className="jump-heading">
            {found.candidates.length === 0 ? (
              <>
                No definition found for <code>{found.name}</code>
              </>
            ) : (
              <>
                {found.candidates.length}
                {found.truncated ? '+' : ''} places may define <code>{found.name}</code>
              </>
            )}
          </p>
          {found.candidates.length > 0 && (
            <ul className="jump-list">
              {found.candidates.map((c) => (
                <li key={`${c.path}:${c.line}`}>
                  <button
                    type="button"
                    className="jump-candidate"
                    onClick={() =>
                      onPick({ path: c.path, line: c.line, label: `definition of ${found.name}` })
                    }
                  >
                    <span className="jump-where">
                      <bdi className="jump-path">
                        {c.path}:{c.line}
                      </bdi>
                      <span className="jump-rank">{RANK_LABELS[c.rank]}</span>
                    </span>
                    <Preview path={c.path} line={c.line} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(found.truncated || found.partial) && (
            <p className="jump-note">
              {found.truncated ? 'Showing the first 50. ' : ''}
              {found.partial ? 'The index covers part of the repo, so some may be missing.' : ''}
            </p>
          )}
        </>
      )}
    </dialog>
  );
}

const nameOf = (found: Found) => ('name' in found ? found.name : '');

/** The candidate's line, as plain text. */
function Preview({ path, line }: { path: string; line: number }) {
  const file = useQuery(fileTextQuery(path, 'new'));
  const text = file.data?.split(/\r?\n/)[line - 1]?.trim();
  return <span className="jump-preview">{text || ' '}</span>;
}
