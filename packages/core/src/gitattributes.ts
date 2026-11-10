// Reads `linguist-generated` and `linguist-vendored` from .gitattributes text (P8).
// A small subset of git's rules. Anything outside it makes the attribute unusable, never guessed.
import { dirName, fileName } from './proof.ts';

export type LinguistAttribute = 'linguist-generated' | 'linguist-vendored';

/** The last rule that set or unset the attribute for a path, as git applies them. */
export type AttributeMatch = {
  readonly value: boolean;
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
};

type Rule = AttributeMatch & {
  readonly dir: string;
  readonly regex: RegExp;
  readonly anchored: boolean;
};

/**
 * Looks up one attribute for a path, given every `.gitattributes` file at base (path → text).
 * Returns the deciding rule, `null` when no rule mentions it, or `'unusable'` when some line that
 * mentions it is outside the subset this parser understands (quoted or bracketed patterns, escapes,
 * macros). Unusable means "don't trust any answer", since a missed line could be an override.
 */
export function attributeFor(
  files: ReadonlyMap<string, string>,
  attribute: LinguistAttribute,
  path: string,
): AttributeMatch | null | 'unusable' {
  const rules = rulesFor(files, attribute);
  if (rules === 'unusable') return 'unusable';
  let decided: AttributeMatch | null = null;
  for (const rule of rules) {
    if (rule.dir !== '' && !path.startsWith(`${rule.dir}/`)) continue;
    const relative = rule.dir === '' ? path : path.slice(rule.dir.length + 1);
    const subject = rule.anchored ? relative : fileName(relative);
    if (rule.regex.test(subject)) {
      decided = { value: rule.value, file: rule.file, line: rule.line, pattern: rule.pattern };
    }
  }
  return decided;
}

/** Rules in the order git applies them: shallower files first, then line order. Later wins. */
function rulesFor(
  files: ReadonlyMap<string, string>,
  attribute: LinguistAttribute,
): Rule[] | 'unusable' {
  const ordered = [...files.keys()]
    .filter((file) => fileName(file) === '.gitattributes')
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
  const rules: Rule[] = [];
  for (const file of ordered) {
    const lines = (files.get(file) ?? '').split(/\r?\n/);
    for (const [index, raw] of lines.entries()) {
      const text = raw.trim();
      if (text === '' || text.startsWith('#') || !text.includes(attribute)) continue;
      const [pattern = '', ...attrs] = text.split(/[ \t]+/);
      if (pattern.startsWith('[attr]') || pattern.startsWith('"')) return 'unusable';
      let value: boolean | null = null;
      for (const attr of attrs) {
        const name = attr.replace(/^[-!]/, '').split('=')[0];
        if (name !== attribute) continue;
        value = attr === attribute || attr === `${attribute}=true`;
      }
      if (value === null) return 'unusable'; // Mentioned, but not as a plain attribute.
      if (pattern.endsWith('/')) continue; // Git never matches a directory pattern to a file.
      const compiled = compile(pattern);
      if (compiled === null) return 'unusable';
      rules.push({
        ...compiled,
        value,
        dir: dirName(file),
        file,
        line: index + 1,
        pattern,
      });
    }
  }
  return rules;
}

const depth = (path: string): number => path.split('/').length;

/** Turns a gitattributes pattern into a regex, or null for syntax this parser doesn't handle. */
function compile(pattern: string): { regex: RegExp; anchored: boolean } | null {
  if (/[[\]\\]/.test(pattern)) return null;
  const body = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  // Without a slash, a pattern matches the file name at any depth.
  const anchored = pattern.includes('/');
  let source = '';
  for (let i = 0; i < body.length; i++) {
    const rest = body.slice(i);
    if (rest.startsWith('**/') && (i === 0 || body[i - 1] === '/')) {
      source += '(?:.*/)?';
      i += 2;
    } else if (rest === '**' && i > 0 && body[i - 1] === '/') {
      source += '.*';
      i += 1;
    } else if (body[i] === '*') {
      source += '[^/]*';
    } else if (body[i] === '?') {
      source += '[^/]';
    } else {
      source += (body[i] ?? '').replace(/[.+^${}()|]/g, '\\$&');
    }
  }
  return { regex: new RegExp(`^${source}$`), anchored };
}
