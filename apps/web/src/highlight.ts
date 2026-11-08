// Syntax highlighting with Shiki: VS Code grammars, the JavaScript regex engine (no wasm), and
// each language loaded only when a file needs it.
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, bundledLanguagesInfo } from 'shiki/langs';
import theme from 'shiki/themes/vitesse-dark.mjs';

export type Token = { text: string; color: string | undefined };

const THEME = 'vitesse-dark';
/** Past this size, plain text renders faster than a reviewer can notice the colors missing. */
const MAX_HIGHLIGHT_CHARS = 400_000;

let highlighter: Promise<HighlighterCore> | undefined;

const byExtension = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  for (const name of [info.id, ...(info.aliases ?? [])]) byExtension.set(name, info.id);
}
byExtension.set('mjs', 'javascript');
byExtension.set('cjs', 'javascript');
byExtension.set('mts', 'typescript');
byExtension.set('cts', 'typescript');
byExtension.set('yml', 'yaml');

function languageFor(path: string): string | null {
  const name = path.split('/').at(-1) ?? '';
  if (name === 'Dockerfile') return 'docker';
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : '';
  return byExtension.get(extension.toLowerCase()) ?? null;
}

/** Splits a file into lines of colored tokens. Unknown languages come back as plain lines. */
export async function highlight(path: string, text: string): Promise<Token[][]> {
  const plain = () => text.split(/\r?\n/).map((line) => [{ text: line, color: undefined }]);
  const lang = languageFor(path);
  if (!lang || text.length > MAX_HIGHLIGHT_CHARS) return plain();
  try {
    highlighter ??= createHighlighterCore({
      themes: [theme],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    const core = await highlighter;
    if (!core.getLoadedLanguages().includes(lang)) {
      const load = bundledLanguages[lang as keyof typeof bundledLanguages];
      if (!load) return plain();
      await core.loadLanguage(load);
    }
    const { tokens } = core.codeToTokens(text, { lang, theme: THEME });
    return tokens.map((line) => line.map((token) => ({ text: token.content, color: token.color })));
  } catch {
    return plain();
  }
}
