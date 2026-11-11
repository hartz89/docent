import type { ReviewSnapshot } from '@docent/server';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, type RefObject, useMemo, useState } from 'react';
import { api } from './api.ts';

type Diff = NonNullable<ReviewSnapshot['diff']>;

/** What the PR did to one file, from the diff. */
export type Change = { added: number; removed: number; isNew: boolean };

type Props = {
  diff: Diff;
  /** Paths a stop cites: the files on the route. */
  onRoute: ReadonlySet<string>;
  /** The file in the code view, highlighted in the tree. */
  selected: string | null;
  onOpen: (path: string) => void;
  filterRef: RefObject<HTMLInputElement | null>;
};

type Folder = { name: string; path: string; folders: Folder[]; files: string[]; changed: number };

/** How many matches "Go to file" lists. */
const MAX_MATCHES = 100;

/** The whole repo at the PR's head, with changed files marked. Any file opens in the code view. */
export function FileTree({ diff, onRoute, selected, onOpen, filterRef }: Props) {
  const tree = useQuery({
    queryKey: ['tree'],
    queryFn: async () => {
      const res = await api.tree.$get();
      if (res.status !== 200) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `The server answered ${res.status}`);
      }
      return res.json();
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const changes = useMemo(() => changesByPath(diff), [diff]);
  const root = useMemo(
    () =>
      tree.data
        ? buildTree(
            tree.data.entries.map((e) => e.path),
            changes,
          )
        : null,
    [tree.data, changes],
  );
  // Folders holding a change start open; the rest start closed.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const isOpen = (folder: Folder) => folder.changed > 0 !== toggled.has(folder.path);
  const toggle = (path: string) =>
    setToggled((all) => {
      const next = new Set(all);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const [query, setQuery] = useState('');
  const matches = useMemo(
    () => (tree.data && query.trim() ? findFiles(tree.data.entries, query.trim(), changes) : []),
    [tree.data, query, changes],
  );

  // A submodule is another repo's commit, not a file here: listed, but not openable.
  const submodules = useMemo(
    () => new Set(tree.data?.entries.filter((e) => e.kind === 'submodule').map((e) => e.path)),
    [tree.data],
  );

  const fileRow = (path: string, depth: number, label: string) => {
    const change = changes.get(path);
    const submodule = submodules.has(path);
    const dot = !change ? null : onRoute.has(path) ? 'on' : 'off';
    return (
      <li key={path}>
        <button
          type="button"
          className={`tree-node file ${change ? 'changed' : 'unchanged'}`}
          style={{ paddingLeft: 4 + depth * 14 }}
          aria-current={path === selected ? 'true' : undefined}
          title={path}
          disabled={submodule}
          onClick={() => onOpen(path)}
        >
          <span className="tree-twisty" aria-hidden="true" />
          {dot ? (
            <span
              className={`route-dot ${dot}`}
              title={dot === 'on' ? 'On the route' : 'Not on the route'}
            />
          ) : (
            <span className="route-dot none" aria-hidden="true" />
          )}
          <span className="tree-name">{label}</span>
          {change && <Diffstat change={change} />}
          {change?.isNew && <span className="tree-new">new</span>}
          {submodule && <span className="tree-count">submodule</span>}
        </button>
      </li>
    );
  };

  const folderRows = (folder: Folder, depth: number): ReactNode[] =>
    folder.folders
      .map((child) => {
        const open = isOpen(child);
        return (
          <li key={child.path}>
            <button
              type="button"
              className="tree-node folder"
              style={{ paddingLeft: 4 + depth * 14 }}
              aria-expanded={open}
              onClick={() => toggle(child.path)}
            >
              <span className="tree-twisty" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
              <span className="tree-name">{child.name}</span>
              {child.changed > 0 && <span className="tree-count">{child.changed} changed</span>}
            </button>
            {open && <ul className="tree">{folderRows(child, depth + 1)}</ul>}
          </li>
        );
      })
      .concat(folder.files.map((path) => fileRow(path, depth, path.split('/').at(-1) ?? path)));

  return (
    <div className="files">
      <label className="go-to-file">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <span className="sr-only">Go to file</span>
        <input
          ref={filterRef}
          type="search"
          placeholder="Go to file"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && matches[0]) onOpen(matches[0]);
            if (event.key === 'Escape') {
              setQuery('');
              event.currentTarget.blur();
            }
          }}
        />
        <kbd>⌘P</kbd>
      </label>

      {tree.isPending && <p className="empty-note">Reading the repository…</p>}
      {tree.isError && (
        <p className="empty-note" role="alert">
          Couldn't list the files: {tree.error.message}
        </p>
      )}
      {root && query.trim() ? (
        matches.length === 0 ? (
          <p className="empty-note">No file matches “{query.trim()}”.</p>
        ) : (
          <ul className="tree" aria-label="Matching files">
            {matches.map((path) => fileRow(path, 0, path))}
          </ul>
        )
      ) : root ? (
        root.folders.length + root.files.length === 0 ? (
          <p className="empty-note">This review has no file list.</p>
        ) : (
          <ul className="tree" aria-label={`Files at ${tree.data?.head.slice(0, 7)}`}>
            {folderRows(root, 0)}
          </ul>
        )
      ) : null}
      {tree.data?.truncated && (
        <p className="empty-note tree-cut">
          The repository is very large, so only the first{' '}
          {tree.data.entries.length.toLocaleString()} files are listed.
        </p>
      )}

      {root && (
        <div className="tree-key" aria-hidden="true">
          <span>
            <i className="route-dot on" />
            on the route
          </span>
          <span>
            <i className="route-dot off" />
            changed, not on the route
          </span>
        </div>
      )}
    </div>
  );
}

function Diffstat({ change }: { change: Change }) {
  return (
    <span className="tree-stat">
      {change.added > 0 && <span className="added">+{change.added}</span>}
      {change.added > 0 && change.removed > 0 && ' '}
      {change.removed > 0 && <span className="removed">−{change.removed}</span>}
    </span>
  );
}

/** Lines added and removed per file at head, and whether the PR created it. */
export function changesByPath(diff: Diff): Map<string, Change> {
  const map = new Map<string, Change>();
  for (const file of diff.files) {
    const lines = file.hunks.flatMap((h) => h.lines);
    const added = lines.filter((l) => l.kind === 'added').length;
    const removed = lines.filter((l) => l.kind === 'removed').length;
    // A new file is one hunk of added lines starting at line 1; the diff has nothing at base.
    const first = lines[0];
    const isNew =
      file.hunks.length === 1 &&
      lines.every((l) => l.kind === 'added') &&
      first?.kind === 'added' &&
      first.newLine === 1;
    map.set(file.path, { added, removed, isNew });
  }
  return map;
}

/** Folders first, then files, each sorted by name, with a count of changed files per folder. */
function buildTree(paths: readonly string[], changes: ReadonlyMap<string, Change>): Folder {
  const root: Folder = { name: '', path: '', folders: [], files: [], changed: 0 };
  const byPath = new Map<string, Folder>([['', root]]);
  for (const path of paths) {
    const parts = path.split('/');
    let folder = root;
    const changed = changes.has(path);
    if (changed) root.changed++;
    for (let i = 0; i < parts.length - 1; i++) {
      const at = parts.slice(0, i + 1).join('/');
      let next = byPath.get(at);
      if (!next) {
        next = { name: parts[i] ?? '', path: at, folders: [], files: [], changed: 0 };
        byPath.set(at, next);
        folder.folders.push(next);
      }
      if (changed) next.changed++;
      folder = next;
    }
    folder.files.push(path);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  for (const folder of byPath.values()) {
    folder.folders.sort((a, b) => byName(a.name, b.name));
    folder.files.sort((a, b) => byName(a, b));
  }
  return root;
}

/**
 * "Go to file": paths containing every word of the query, in any case. Changed files come
 * first, then matches on the file's own name, then shorter paths.
 */
function findFiles(
  entries: readonly { path: string }[],
  query: string,
  changes: ReadonlyMap<string, Change>,
): string[] {
  const words = query.toLowerCase().split(/\s+/);
  const scored: { path: string; score: number }[] = [];
  for (const { path } of entries) {
    const lower = path.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    const score =
      (changes.has(path) ? 0 : 2) +
      (words.some((w) => name.includes(w)) ? 0 : 1) +
      path.length / 1e4;
    scored.push({ path, score });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_MATCHES)
    .map((s) => s.path);
}
