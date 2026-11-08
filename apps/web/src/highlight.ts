// Syntax highlighting with Shiki: VS Code grammars, the JavaScript regex engine (no wasm), and
// each language loaded only when a file needs it. Shiki itself loads on the first highlight, not
// with the app: it's about a quarter of the bundle, and nothing needs it until code is on screen.
import type { HighlighterCore } from 'shiki/core';

export type Token = { text: string; color: string | undefined };

const THEME = 'vitesse-dark';
/** Past this size, plain text renders faster than a reviewer can notice the colors missing. */
const MAX_HIGHLIGHT_CHARS = 400_000;

type Shiki = {
  core: HighlighterCore;
  languageFor: (path: string) => string | null;
  load: (lang: string) => Promise<boolean>;
};

let shiki: Promise<Shiki> | undefined;

async function loadShiki(): Promise<Shiki> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, langs, theme] =
    await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs'),
      import('shiki/themes/vitesse-dark.mjs'),
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
    themes: [theme.default],
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
  const plain = () => text.split(/\r?\n/).map((line) => [{ text: line, color: undefined }]);
  if (text.length > MAX_HIGHLIGHT_CHARS) return plain();
  try {
    shiki ??= loadShiki();
    const { core, languageFor, load } = await shiki;
    const lang = languageFor(path);
    if (!lang || !(await load(lang))) return plain();
    const { tokens } = core.codeToTokens(text, { lang, theme: THEME });
    return tokens.map((line) => line.map((token) => ({ text: token.content, color: token.color })));
  } catch {
    shiki = undefined; // a failed load (say, a dropped chunk request) gets retried next time
    return plain();
  }
}
