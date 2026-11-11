// Jump to definition and imports over a whole repo, from each file's symbols (N2–N5).
// Search-based: a name is looked up, never type-checked, so a jump can be ambiguous. Then every
// candidate comes back, ranked, and the reviewer picks. Nothing is guessed.
import type { DefinitionKind, Export, FileSymbols } from './symbols.ts';

/** How a candidate was found, best first: in the file itself, through its imports, or anywhere. */
export type CandidateRank = 'same_file' | 'import' | 'repo';

/**
 * A place a symbol may be defined. `kind` is `'export'` for an anonymous `export default`, and
 * `'module'` when a namespace import leads to a whole file.
 */
export type Candidate = {
  path: string;
  line: number;
  kind: DefinitionKind | 'export';
  rank: CandidateRank;
};

/** `paths` from the repo's root `tsconfig.json`, with `baseUrl` already applied. */
export type TsconfigPaths = ReadonlyArray<{ pattern: string; targets: readonly string[] }>;

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
/** TypeScript lets `./a.js` name `./a.ts`, since that's what it compiles to. */
const COMPILED_FROM: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
/** tsconfig `paths` beyond these are ignored. */
const MAX_PATH_PATTERNS = 100;
const MAX_PATH_TARGETS = 10;
/** Re-export chains longer than this stop; real ones are a few steps. */
const MAX_HOPS = 16;

export class SymbolIndex {
  readonly #paths: ReadonlySet<string>;
  readonly #files: ReadonlyMap<string, FileSymbols>;
  readonly #tsconfig: TsconfigPaths;
  /** Name → every file that defines it. */
  readonly #byName = new Map<string, string[]>();

  /**
   * `paths` is every file in the repo, indexed or not, so an import of `./styles.css` still
   * resolves. `files` holds the symbols of those that were indexed.
   */
  constructor(
    paths: ReadonlySet<string>,
    files: ReadonlyMap<string, FileSymbols>,
    tsconfig: TsconfigPaths = [],
  ) {
    this.#paths = paths;
    this.#files = files;
    this.#tsconfig = tsconfig;
    for (const [path, symbols] of files) {
      for (const name of new Set(symbols.definitions.map((d) => d.name))) {
        const list = this.#byName.get(name);
        if (list) list.push(path);
        else this.#byName.set(name, [path]);
      }
    }
    for (const list of this.#byName.values()) list.sort();
  }

  /** Resolved specifiers, by the importing folder (for relative ones) and specifier. */
  readonly #resolved = new Map<string, string | null>();

  get fileCount(): number {
    return this.#files.size;
  }

  /**
   * N4: the repo file an import specifier names, or null. Only relative specifiers and the root
   * tsconfig's `paths` resolve; a package name or anything else is left unresolved.
   */
  resolveImport(from: string, spec: string): string | null {
    const relative =
      spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
    const key = relative ? `${dirName(from)}\0${spec}` : `\0${spec}`;
    const cached = this.#resolved.get(key);
    if (cached !== undefined) return cached;
    const found = relative ? this.#resolveRelative(from, spec) : this.#resolvePaths(spec);
    this.#resolved.set(key, found);
    return found;
  }

  #resolveRelative(from: string, spec: string): string | null {
    const target = normalize(`${dirName(from)}/${spec}`);
    return target === null ? null : this.#withExtension(target);
  }

  #resolvePaths(spec: string): string | null {
    let best: { prefix: number; found: string | null } | null = null;
    for (const { pattern, targets } of this.#tsconfig) {
      const star = pattern.indexOf('*');
      const prefix = star === -1 ? pattern : pattern.slice(0, star);
      const suffix = star === -1 ? '' : pattern.slice(star + 1);
      const matches =
        star === -1
          ? spec === pattern
          : spec.length >= prefix.length + suffix.length &&
            spec.startsWith(prefix) &&
            spec.endsWith(suffix);
      // TypeScript picks the pattern with the longest prefix.
      if (!matches || (best && best.prefix >= prefix.length)) continue;
      const middle = star === -1 ? '' : spec.slice(prefix.length, spec.length - suffix.length);
      let found: string | null = null;
      for (const target of targets) {
        const path = normalize(target.replace('*', middle));
        found = path === null ? null : this.#withExtension(path);
        if (found) break;
      }
      best = { prefix: prefix.length, found };
    }
    return best?.found ?? null;
  }

  /**
   * N2: every place `symbol` may be defined, best first. With `from`, definitions in that file
   * come first (nearest `line` first), then those its imports lead to, then the rest of the repo
   * by path. Each place appears once (N5). At most `limit` come back; `truncated` says whether
   * there were more, so a common name stays cheap to look up.
   */
  definitions(
    symbol: string,
    from?: { path: string; line?: number },
    limit = Number.POSITIVE_INFINITY,
  ): { candidates: Candidate[]; truncated: boolean } {
    const found: Candidate[] = [];
    const seen = new Set<string>();
    let truncated = false;
    const add = (candidate: Candidate) => {
      if (truncated) return;
      const key = `${candidate.path}:${candidate.line}`;
      if (seen.has(key)) return;
      if (found.length === limit) {
        truncated = true;
        return;
      }
      seen.add(key);
      found.push(candidate);
    };

    const own = from ? this.#files.get(from.path) : undefined;
    if (from && own) {
      const line = from.line;
      const here = own.definitions.filter((d) => d.name === symbol);
      if (line !== undefined) {
        here.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line) || a.line - b.line);
      }
      for (const d of here) add({ path: from.path, line: d.line, kind: d.kind, rank: 'same_file' });

      // N3: an imported name leads to its definition, through any re-exports.
      for (const binding of own.imports.filter((i) => i.local === symbol)) {
        const target = this.resolveImport(from.path, binding.spec);
        if (target) this.#follow(target, binding.imported, 0, new Set(), add);
      }
      // `ns.symbol()` after `import * as ns`: the symbol is followed through that module.
      for (const binding of own.imports.filter((i) => i.imported === '*')) {
        const target = this.resolveImport(from.path, binding.spec);
        if (target && this.#files.has(target)) this.#follow(target, symbol, 0, new Set(), add);
      }
      // Then any file this one imports that defines the name, like a method on an imported class.
      const specs = new Set([
        ...own.imports.map((i) => i.spec),
        ...own.exports.flatMap((e) => (e.kind === 'from' ? [e.spec] : [])),
        ...own.exportsAll,
      ]);
      for (const spec of specs) {
        const target = this.resolveImport(from.path, spec);
        const symbols = target ? this.#files.get(target) : undefined;
        if (!target || !symbols) continue;
        for (const d of symbols.definitions) {
          if (d.name === symbol) add({ path: target, line: d.line, kind: d.kind, rank: 'import' });
        }
      }
    }

    for (const path of this.#byName.get(symbol) ?? []) {
      if (truncated) break;
      for (const d of this.#files.get(path)?.definitions ?? []) {
        if (d.name === symbol) add({ path, line: d.line, kind: d.kind, rank: 'repo' });
      }
    }
    return { candidates: found, truncated };
  }

  /** Finds where `path`'s export `name` is defined. `'*'` means the module itself. */
  #follow(
    path: string,
    name: string,
    hops: number,
    visited: Set<string>,
    add: (candidate: Candidate) => void,
  ): void {
    const key = `${path}\0${name}`;
    if (hops > MAX_HOPS || visited.has(key)) return;
    visited.add(key);
    const symbols = this.#files.get(path);
    if (name === '*' || !symbols) {
      // A namespace import, or a file that wasn't indexed: the file is the best answer.
      add({ path, line: 1, kind: 'module', rank: 'import' });
      return;
    }
    const exports = symbols.exports.filter((e) => e.name === name);
    for (const entry of exports) this.#followExport(path, entry, hops, visited, add);
    if (exports.length > 0) return;
    // CommonJS and scripts don't declare exports: there, a top-level definition will do.
    const isModule = symbols.exports.length > 0 || symbols.exportsAll.length > 0;
    if (!isModule) {
      const defined = symbols.definitions.filter((d) => d.name === name && d.topLevel);
      for (const d of defined) add({ path, line: d.line, kind: d.kind, rank: 'import' });
      return;
    }
    if (name === 'default') return;
    for (const spec of symbols.exportsAll) {
      const next = this.resolveImport(path, spec);
      if (next) this.#follow(next, name, hops + 1, visited, add);
    }
  }

  #followExport(
    path: string,
    entry: Export,
    hops: number,
    visited: Set<string>,
    add: (candidate: Candidate) => void,
  ): void {
    if (entry.kind === 'from') {
      const next = this.resolveImport(path, entry.spec);
      if (next) this.#follow(next, entry.imported, hops + 1, visited, add);
      return;
    }
    const symbols = this.#files.get(path);
    const local = entry.local;
    if (local === null || !symbols) {
      add({ path, line: entry.line, kind: 'export', rank: 'import' });
      return;
    }
    // Only a top-level definition can be exported; a nested one of the same name isn't it.
    const defined = symbols.definitions.filter((d) => d.name === local && d.topLevel);
    for (const d of defined) add({ path, line: d.line, kind: d.kind, rank: 'import' });
    if (defined.length > 0) return;
    // `import { a } from './x'; export { a }`: keep following the import.
    const bindings = symbols.imports.filter((i) => i.local === local);
    for (const binding of bindings) {
      const next = this.resolveImport(path, binding.spec);
      if (next) this.#follow(next, binding.imported, hops + 1, visited, add);
    }
    if (bindings.length === 0) add({ path, line: entry.line, kind: 'export', rank: 'import' });
  }

  /** The file a module path names, trying TypeScript's and Node's extensions and index files. */
  #withExtension(path: string): string | null {
    const has = (p: string) => this.#paths.has(p);
    // Like TypeScript, `./a.js` means `./a.ts` when both exist.
    const dot = path.lastIndexOf('.');
    const extension = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
    for (const replacement of COMPILED_FROM[extension] ?? []) {
      const candidate = path.slice(0, dot) + replacement;
      if (has(candidate)) return candidate;
    }
    if (has(path)) return path;
    for (const ext of SCRIPT_EXTENSIONS) if (has(path + ext)) return path + ext;
    const base = path === '' ? 'index' : `${path}/index`;
    for (const ext of SCRIPT_EXTENSIONS) if (has(base + ext)) return base + ext;
    return null;
  }
}

/**
 * Reads `compilerOptions.paths` from a root `tsconfig.json`, which may have comments and trailing
 * commas. `extends` isn't followed. Anything unexpected gives no paths.
 */
export function tsconfigPaths(text: string): TsconfigPaths {
  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(text));
  } catch {
    return [];
  }
  const options = (config as { compilerOptions?: unknown } | null)?.compilerOptions;
  if (typeof options !== 'object' || options === null) return [];
  const { baseUrl, paths } = options as { baseUrl?: unknown; paths?: unknown };
  if (typeof paths !== 'object' || paths === null) return [];
  const base = typeof baseUrl === 'string' ? baseUrl : '.';
  const result: { pattern: string; targets: string[] }[] = [];
  // The file comes from the PR, so it's capped: a real one has a handful of each.
  for (const [pattern, targets] of Object.entries(paths).slice(0, MAX_PATH_PATTERNS)) {
    if (!Array.isArray(targets) || (pattern.match(/\*/g)?.length ?? 0) > 1) continue;
    const usable = targets
      .filter((t): t is string => typeof t === 'string' && (t.match(/\*/g)?.length ?? 0) <= 1)
      .slice(0, MAX_PATH_TARGETS);
    result.push({ pattern, targets: usable.map((t) => `${base}/${t}`) });
  }
  return result;
}

/** JSON with `//` and block comments and trailing commas, as tsconfig allows, made plain. */
function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function dirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** A repo-relative path with `.` and `..` worked out, or null if it climbs out of the repo. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}
