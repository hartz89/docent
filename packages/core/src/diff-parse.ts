import type { CommitSha } from './basics.ts';
import { type Diff, makeDiff, type RawFile, type RawHunk, type RawHunkLine } from './diff.ts';

/**
 * Parses a unified diff, as `git diff` or `gh pr diff` prints it, into core's Diff.
 *
 * Handles renames, new and deleted files, mode-only changes, binary files (kept with no hunks),
 * quoted paths, and "\ No newline at end of file" markers. Hunk bodies are read by the counts
 * in their headers, so a removed line that starts with "--- " can't be mistaken for a header.
 */
export function parseUnifiedDiff(text: string, base: CommitSha, head: CommitSha): Diff {
  return makeDiff(base, head, parseRawFiles(text));
}

/** The raw files of a unified diff, before line numbering and hunk ids. */
export function parseRawFiles(text: string): RawFile[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files: RawFile[] = [];
  let i = 0;

  while (i < lines.length) {
    const header = lines[i] ?? '';
    if (!header.startsWith('diff --git ')) {
      i++;
      continue;
    }
    const fromHeader = splitGitHeader(header.slice('diff --git '.length));
    let oldPath = fromHeader?.[0] ?? '';
    let path = fromHeader?.[1] ?? '';
    let deleted = false;
    const hunks: RawHunk[] = [];
    i++;

    // Extended headers, up to the first hunk or the next file.
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (line.startsWith('diff --git ') || line.startsWith('@@ ')) break;
      if (line.startsWith('rename from ')) oldPath = unquote(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) path = unquote(line.slice('rename to '.length));
      else if (line.startsWith('deleted file mode')) deleted = true;
      else if (line.startsWith('--- ')) {
        const name = stripPrefix(unquote(trimTimestamp(line.slice(4))), 'a/');
        if (name !== null) oldPath = name;
      } else if (line.startsWith('+++ ')) {
        const name = stripPrefix(unquote(trimTimestamp(line.slice(4))), 'b/');
        if (name !== null) path = name;
        else deleted = true;
      }
      i++;
    }

    while (i < lines.length && (lines[i] ?? '').startsWith('@@ ')) {
      const parsed = parseHunk(lines, i);
      if (parsed.hunk) hunks.push(parsed.hunk);
      i = parsed.next;
    }

    // D1: a deleted file keeps the path it had at base.
    if (deleted) path = oldPath;
    files.push({ path, oldPath, hunks });
  }
  return files;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Reads one hunk. A malformed header is skipped (hunk: null), so one bad line never sinks a diff. */
function parseHunk(
  lines: readonly string[],
  start: number,
): { hunk: RawHunk | null; next: number } {
  const match = HUNK_HEADER.exec(lines[start] ?? '');
  if (!match) return { hunk: null, next: start + 1 };
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
  let newLeft = match[4] === undefined ? 1 : Number(match[4]);
  const body: RawHunkLine[] = [];
  let i = start + 1;

  while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const line = lines[i] ?? '';
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') {
      body.push({ kind: 'added', text });
      newLeft--;
    } else if (mark === '-') {
      body.push({ kind: 'removed', text });
      oldLeft--;
    } else if (mark === ' ' || line === '') {
      // Some tools trim the single space off a blank context line.
      body.push({ kind: 'context', text });
      oldLeft--;
      newLeft--;
    } else if (mark !== '\\') {
      break; // The counts promised more lines than the diff has.
    }
    i++;
  }
  // A "\ No newline at end of file" marker may follow the last line.
  while ((lines[i] ?? '').startsWith('\\')) i++;
  return { hunk: { oldStart, newStart, lines: body }, next: i };
}

/** Splits `a/x b/y` into its two paths. Ambiguous when paths contain " b/"; renames fix it later. */
function splitGitHeader(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    const first = unquote(rest.slice(0, end + 1));
    const second = unquote(rest.slice(end + 2));
    return [stripPrefix(first, 'a/') ?? first, stripPrefix(second, 'b/') ?? second];
  }
  // Without renames both halves are equal, so try the middle split first.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return [a.slice(2), b.slice(2)];
  }
  const at = rest.indexOf(' b/');
  if (at === -1) return null;
  const second = unquote(rest.slice(at + 1));
  return [rest.slice(2, at), stripPrefix(second, 'b/') ?? second];
}

function closingQuote(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return text.length - 1;
}

/** Strips the `a/` or `b/` prefix; null for /dev/null (the file is absent on that side). */
function stripPrefix(name: string, prefix: string): string | null {
  if (name === '/dev/null') return null;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** `--- a/x\t2020-01-01 ...`: some tools append a timestamp after a tab. */
const trimTimestamp = (name: string): string =>
  name.startsWith('"') ? name : (name.split('\t')[0] ?? name);

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };

/** Git C-quotes paths with unusual characters, using octal escapes for UTF-8 bytes. */
function unquote(name: string): string {
  if (!(name.startsWith('"') && name.endsWith('"') && name.length >= 2)) return name;
  // Rebuild the path as percent-encoded UTF-8, so octal byte escapes decode as one character.
  let encoded = '';
  const inner = name.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i] ?? '';
    if (char !== '\\') {
      encoded += encodeURIComponent(char);
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (octal) {
      encoded += `%${Number.parseInt(octal[0], 8).toString(16).padStart(2, '0')}`;
      i += 3;
    } else {
      const next = inner[i + 1] ?? '';
      encoded += encodeURIComponent(ESCAPES[next] ?? next);
      i++;
    }
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return inner; // Not valid UTF-8: keep the escaped form rather than guess.
  }
}
