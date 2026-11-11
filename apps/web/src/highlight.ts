// Syntax highlighting with Shiki: VS Code grammars, the JavaScript regex engine (no wasm), and
// each language loaded only when a file needs it. Shiki itself loads on the first highlight, not
// with the app: it's about a quarter of the bundle, and nothing needs it until code is on screen.
import type { HighlighterCore } from 'shiki/core';

/** A run of text with its color in each theme. The page picks one in CSS, so switching themes
 * doesn't re-highlight anything. */
export type Token = { text: string; dark: string | undefined; light: string | undefined };

// github-light-default for light: measured on a real file, vitesse-light left 85% of characters
// under 4.5:1 contrast on the light ground, and this one 22% (only its comment grey, at 4.39).
const THEMES = { dark: 'vitesse-dark', light: 'github-light-default' } as const;
/** Past this size, plain text renders faster than a reviewer can notice the colors missing. */
const MAX_HIGHLIGHT_CHARS = 400_000;

type Shiki = {
  core: HighlighterCore;
  languageFor: (path: string) => string | null;
  load: (lang: string) => Promise<boolean>;
};

let shiki: Promise<Shiki> | undefined;

async function loadShiki(): Promise<Shiki> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, langs, dark, light] =
    await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs'),
      import('shiki/themes/vitesse-dark.mjs'),
      import('shiki/themes/github-light-default.mjs'),
    ]);

  const byExtension = new Map<string, string>();
  for (const info of langs.bundledLanguagesInfo) {
    for (const name of [info.id, ...(info.aliases ?? [])]) byExtension.set(name, info.id);
  }
  byExtension.set('mjs', 'javascript');
  byExtension.set('cjs', 'javascript');
  byExtension.set('mts', 'typescript');
  byExtension.set('cts', 'typescript');
  byExtension.set('yml', 'yaml');

  const core = await createHighlighterCore({
    themes: [dark.default, light.default],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });

  return {
    core,
    languageFor(path) {
      const name = path.split('/').at(-1) ?? '';
      if (name === 'Dockerfile') return 'docker';
      const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : '';
      return byExtension.get(extension.toLowerCase()) ?? null;
    },
    async load(lang) {
      if (core.getLoadedLanguages().includes(lang)) return true;
      const grammar = langs.bundledLanguages[lang as keyof typeof langs.bundledLanguages];
      if (!grammar) return false;
      await core.loadLanguage(grammar);
      return true;
    },
  };
}

/** Splits a file into lines of colored tokens. Unknown languages come back as plain lines. */
export async function highlight(path: string, text: string): Promise<Token[][]> {
  const plain = () =>
    text.split(/\r?\n/).map((line) => [{ text: line, dark: undefined, light: undefined }]);
  if (text.length > MAX_HIGHLIGHT_CHARS) return plain();
  try {
    // Only a failed load clears the cache, so one file that fails to tokenize doesn't throw away
    // the highlighter and every grammar it has compiled. (Some browsers cache a failed import(),
    // so a retry may fail again; then files stay plain, which is the fallback anyway.)
    shiki ??= loadShiki().catch((error: unknown) => {
      shiki = undefined;
      throw error;
    });
    const { core, languageFor, load } = await shiki;
    const lang = languageFor(path);
    if (!lang || !(await load(lang))) return plain();
    const lines = core.codeToTokensWithThemes(text, { lang, themes: THEMES });
    return lines.map((line) =>
      line.map((token) => ({
        text: token.content,
        dark: token.variants.dark?.color,
        light: token.variants.light?.color,
      })),
    );
  } catch {
    return plain();
  }
}
