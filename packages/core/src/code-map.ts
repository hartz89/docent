// The code map (M1–M4): what a change touches, and who uses it, read from the symbol index alone.
// Search-based like the rest of navigation, so it's deterministic and never runs project code.
import type { Diff, DiffFile } from './diff.ts';
import type { SymbolIndex } from './symbol-index.ts';
import type { Definition, DefinitionKind, FileSymbols } from './symbols.ts';

/**
 * A place on the map: a top-level definition, or a file's top-level code outside any definition.
 * `line` is where it opens: a definition's name, or the first line that put the file on the map.
 */
export type MapNode = { id: string; path: string; line: number } & (
  | { kind: DefinitionKind; name: string }
  | { kind: 'file' }
);

/** The nodes of one file, by line. */
export type MapGroup = { path: string; nodes: MapNode[] };

/** `from` uses `to`, on `uses` lines. Both ends are on the map. */
export type MapEdge = { from: string; to: string; uses: number };

export type CodeMap = {
  /** What the PR changed, by file, in the diff's order. */
  changed: MapGroup[];
  /** What uses the changed definitions, by file, most connected first. */
  callers: MapGroup[];
  /** Into a changed node, from a caller or from another changed node. */
  edges: MapEdge[];
  /** Changed files with no definitions in the index, like docs, styles or config. */
  otherFiles: string[];
  /** How many of each were left off the map by its caps. */
  hidden: { changed: number; callers: number; otherFiles: number };
  /** Some callers may be missing: a definition was used in more files than the map reads. */
  truncated: boolean;
};

export type MapLimits = {
  /** Changed nodes shown. */
  changed: number;
  /** Caller nodes shown. */
  callers: number;
  /** Other changed files listed. */
  otherFiles: number;
  /** Files read for one changed definition's callers. */
  filesPerDefinition: number;
};

/** Small enough to read at a glance; the rest is counted, never silently dropped. */
export const MAP_LIMITS: MapLimits = {
  changed: 12,
  callers: 12,
  otherFiles: 8,
  filesPerDefinition: 60,
};

/** Candidates one caller check looks at. Ample for a real file. */
const LOOKUP_LIMIT = 50;

/** A top-level definition with its overloads folded in: one name, one span. */
type Span = { name: string; kind: DefinitionKind; line: number; endLine: number };

export function codeMap(index: SymbolIndex, diff: Diff, limits: MapLimits = MAP_LIMITS): CodeMap {
  // M1: the changed nodes, in the diff's order.
  const changedAll: MapNode[] = [];
  const otherAll: string[] = [];
  for (const file of diff.files) {
    const touch = touchesOf(file);
    const symbols = index.symbolsOf(file.path);
    // Deleted, renamed or binary files have nothing at head to place: they're listed.
    if (!symbols || touch.first === null) {
      otherAll.push(file.path);
      continue;
    }
    const touched = spansOf(symbols).filter((span) => touch.inside(span));
    if (touched.length > 0) changedAll.push(...touched.map((s) => definitionNode(file.path, s)));
    else changedAll.push(fileNode(file.path, touch.first));
  }
  const changed = changedAll.slice(0, limits.changed);
  const changedIds = new Set(changed.map((n) => n.id));

  // M2: who uses each changed definition.
  const callers = new Map<string, { node: MapNode; targets: Set<string>; uses: number }>();
  const edges: MapEdge[] = [];
  let truncated = false;
  for (const target of changed) {
    if (target.kind === 'file') continue;
    const end = endOf(index, target);
    let files = index.references(target.name).files;
    if (files.length > limits.filesPerDefinition) {
      truncated = true;
      files = files.slice(0, limits.filesPerDefinition);
    }
    for (const { path, lines } of files) {
      const symbols = index.symbolsOf(path);
      const first = lines[0];
      if (!symbols || first === undefined) continue;
      const found = index.definitions(target.name, { path, line: first }, LOOKUP_LIMIT);
      const resolves = found.candidates.some(
        (c) => c.path === target.path && c.line === target.line && c.rank !== 'repo',
      );
      if (!resolves) {
        truncated ||= found.truncated;
        continue;
      }
      for (const { node, uses } of usersIn(path, symbols, lines, target, end)) {
        edges.push({ from: node.id, to: target.id, uses });
        // M3: a changed node that uses another stays on the changed side.
        if (changedIds.has(node.id)) continue;
        const known = callers.get(node.id);
        if (known) {
          known.targets.add(target.id);
          known.uses += uses;
        } else callers.set(node.id, { node, targets: new Set([target.id]), uses });
      }
    }
  }

  // M4: the most connected callers, then the busiest, then by place.
  const ranked = [...callers.values()].sort(
    (a, b) =>
      b.targets.size - a.targets.size ||
      b.uses - a.uses ||
      compare(a.node.path, b.node.path) ||
      a.node.line - b.node.line,
  );
  const shownCallers = ranked.slice(0, limits.callers).map((c) => c.node);
  const shown = new Set([...changedIds, ...shownCallers.map((n) => n.id)]);
  return {
    changed: grouped(changed),
    callers: grouped(shownCallers),
    edges: edges.filter((e) => shown.has(e.from) && shown.has(e.to)),
    otherFiles: otherAll.slice(0, limits.otherFiles),
    hidden: {
      changed: changedAll.length - changed.length,
      callers: ranked.length - shownCallers.length,
      otherFiles: Math.max(0, otherAll.length - limits.otherFiles),
    },
    truncated,
  };
}

/**
 * Where a file changed at head: its added lines, and the gaps where lines were removed. A gap
 * after head line `n` touches a definition only when it falls inside it, between `n` and `n + 1`.
 */
function touchesOf(file: DiffFile): { first: number | null; inside: (span: Span) => boolean } {
  const added: number[] = [];
  const gaps: number[] = [];
  for (const hunk of file.hunks) {
    // A hunk with no line at head (a deleted file's) has nowhere to put its removals.
    const firstHead = hunk.lines.find((l) => l.kind !== 'removed');
    if (!firstHead) continue;
    let before = firstHead.newLine - 1;
    for (const line of hunk.lines) {
      if (line.kind === 'removed') gaps.push(before);
      else {
        before = line.newLine;
        if (line.kind === 'added') added.push(line.newLine);
      }
    }
  }
  const lines = [...added, ...gaps.map((g) => g + 1)];
  return {
    first: lines.length > 0 ? Math.min(...lines) : null,
    inside: ({ line, endLine }) =>
      added.some((l) => l >= line && l <= endLine) ||
      gaps.some((g) => g >= line && g + 1 <= endLine),
  };
}

/**
 * A file's top-level definitions, by line. Overloads, one after another with the same name and
 * kind, fold into one span; a `type User` and a `const User` stay apart.
 */
function spansOf(symbols: FileSymbols): Span[] {
  const spans: Span[] = [];
  const tops = symbols.definitions.filter((d) => d.topLevel).sort((a, b) => a.line - b.line);
  for (const d of tops) {
    const last = spans.at(-1);
    if (last && last.name === d.name && last.kind === d.kind) {
      last.endLine = Math.max(last.endLine, d.endLine);
    } else spans.push({ name: d.name, kind: d.kind, line: d.line, endLine: d.endLine });
  }
  return spans;
}

/** The last line of a changed definition, overloads included. */
function endOf(index: SymbolIndex, target: MapNode & { name: string }): number {
  const symbols = index.symbolsOf(target.path);
  const span = symbols ? spansOf(symbols).find((s) => s.line === target.line) : undefined;
  return span?.endLine ?? target.line;
}

/**
 * M2: the nodes in one file that use `target`, with how many lines each uses it on. A line inside
 * a top-level definition counts for that definition. Lines outside every definition count for the
 * file itself, only when no definition in it uses the target, and not on an import or export.
 * The target's own lines never count.
 */
function usersIn(
  path: string,
  symbols: FileSymbols,
  lines: readonly number[],
  target: MapNode & { name: string },
  end: number,
): { node: MapNode; uses: number }[] {
  const spans = spansOf(symbols);
  const statements = new Set([
    ...symbols.imports.filter((i) => i.local === target.name).map((i) => i.line),
    ...symbols.exports.map((e) => e.line),
  ]);
  const users = new Map<string, { node: MapNode; uses: number }>();
  let loose: { line: number; uses: number } | null = null;
  for (const line of lines) {
    if (path === target.path && line >= target.line && line <= end) continue;
    const holder = spans.find((s) => s.line <= line && line <= s.endLine);
    if (holder) {
      const node = definitionNode(path, holder);
      const known = users.get(node.id);
      if (known) known.uses++;
      else users.set(node.id, { node, uses: 1 });
    } else if (!statements.has(line)) {
      if (loose) loose.uses++;
      else loose = { line, uses: 1 };
    }
  }
  if (users.size === 0 && loose) return [{ node: fileNode(path, loose.line), uses: loose.uses }];
  return [...users.values()];
}

const definitionNode = (path: string, span: Span | Definition): MapNode => ({
  id: `${path}:${span.line}`,
  path,
  line: span.line,
  kind: span.kind,
  name: span.name,
});

const fileNode = (path: string, line: number): MapNode => ({ id: path, path, line, kind: 'file' });

/** Nodes by file, files in the order they first appear, nodes in a file by line. */
function grouped(nodes: readonly MapNode[]): MapGroup[] {
  const groups = new Map<string, MapNode[]>();
  for (const node of nodes) {
    const group = groups.get(node.path);
    if (group) group.push(node);
    else groups.set(node.path, [node]);
  }
  return [...groups].map(([path, list]) => ({
    path,
    nodes: list.sort((a, b) => a.line - b.line),
  }));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
