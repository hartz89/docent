// Jump to definition, the parts with no screen: what a click in a line of code points at, and the
// trail of files a reviewer explores away from a stop.

/** What a ⌘-click or the keyboard landed on, with its place in the line (`end` exclusive). */
export type JumpTarget =
  | { kind: 'symbol'; name: string; start: number; end: number }
  | { kind: 'import'; spec: string; start: number; end: number };

const NAME_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]/u;
const NAME_START = /[\p{L}\p{Nl}_$]/u;
/** The server's limit on a symbol's length. */
const LONGEST_NAME = 200;
/**
 * The quoted specifier of a JavaScript or TypeScript import on one line: `from '…'`, `import '…'`,
 * `import('…')` and `require('…')`. Group 2 is the specifier.
 */
const IMPORT_STRING = /\b(?:from|import|require)\s*\(?\s*(['"])([^'"\n]{1,1000})\1/g;

/**
 * What the character at `column` of a line points at: an import specifier, a name, or nothing.
 * A column just past the end of a name still counts, since a click on a name's last half lands
 * there.
 */
export function targetAt(text: string, column: number): JumpTarget | null {
  for (const match of text.matchAll(IMPORT_STRING)) {
    const spec = match[2] ?? '';
    const start = match.index + match[0].length - spec.length - 1;
    const end = start + spec.length;
    if (column >= start && column < end) return { kind: 'import', spec, start, end };
  }
  let at = column;
  if (!NAME_PART.test(text[at] ?? '')) at -= 1;
  if (at < 0 || !NAME_PART.test(text[at] ?? '')) return null;
  let start = at;
  let end = at + 1;
  while (start > 0 && NAME_PART.test(text[start - 1] ?? '')) start -= 1;
  while (end < text.length && NAME_PART.test(text[end] ?? '')) end += 1;
  const name = text.slice(start, end);
  // A number, or something too long to be a name the server will look up.
  if (!NAME_START.test(name[0] ?? '') || name.length > LONGEST_NAME) return null;
  return { kind: 'symbol', name, start, end };
}

/**
 * Files explored away from a stop, like a browser's history. `at` is the entry on screen; -1 is
 * the stop itself, which is always the start of the trail. Opening a file drops anything ahead.
 */
export type Trail<T> = { entries: readonly T[]; at: number };

export const emptyTrail = <T>(): Trail<T> => ({ entries: [], at: -1 });

/** The entry on screen, or null at the stop. */
export const current = <T>(trail: Trail<T>): T | null => trail.entries[trail.at] ?? null;

export function visit<T>(trail: Trail<T>, entry: T, same: (a: T, b: T) => boolean): Trail<T> {
  const here = current(trail);
  if (here && same(here, entry)) return trail;
  const entries = [...trail.entries.slice(0, trail.at + 1), entry];
  return { entries, at: entries.length - 1 };
}

export const canGoBack = <T>(trail: Trail<T>) => trail.at >= 0;
export const canGoForward = <T>(trail: Trail<T>) => trail.at < trail.entries.length - 1;

export const back = <T>(trail: Trail<T>): Trail<T> =>
  canGoBack(trail) ? { ...trail, at: trail.at - 1 } : trail;

export const forward = <T>(trail: Trail<T>): Trail<T> =>
  canGoForward(trail) ? { ...trail, at: trail.at + 1 } : trail;
