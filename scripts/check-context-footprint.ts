// Keeps the always-loaded agent context small. Every session starts with the root CLAUDE.md,
// .claude/CLAUDE.md, the .claude/rules files that have no `paths:`, and everything those
// @-import (AGENTS.md, and so on). Each token there is paid on every turn. This check fails when
// that set grows past a budget. CLAUDE.local.md is left out: it's per-machine, not the repo's.
//
// Tokens are estimated as characters / 4, rounded up per file. That's the usual rule of thumb
// for English text, and it's deterministic and needs no API call. It isn't the model's real
// count; what matters is that the number moves when the files do.
//
// Raising the budget is a harness change: say why in the PR.
// Run: node scripts/check-context-footprint.ts (part of pnpm verify).
// Background: docs/process/harness-evals.md

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** About 15% over the 1,368 tokens measured when the check was added (2026-11-10). */
export const BUDGET_TOKENS = 1580;

/** Claude Code follows imports up to 4 hops from the file that loads at start. */
const MAX_HOPS = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The @-imports in a markdown file, as written. Like Claude Code, it skips fenced code blocks
 * and inline code, and only counts an @ at the start of a word (so an email isn't an import).
 */
export function importsIn(markdown: string): string[] {
  const withoutCode = markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
  return [...withoutCode.matchAll(/(?:^|\s)@([^\s`]+)/g)].map((m) => m[1] ?? '');
}

export type Footprint = { files: { path: string; tokens: number }[]; total: number };

/** Rule files under .claude/rules load at start unless their frontmatter scopes them with `paths:`. */
function unscopedRules(root: string): string[] {
  const dir = join(root, '.claude/rules');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => !/^paths:/m.test(frontmatter(readFileSync(path, 'utf8'))));
}

function frontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return '';
  const end = markdown.indexOf('\n---', 4);
  return end === -1 ? '' : markdown.slice(4, end);
}

/** The files that load at start plus every repo file they import, each counted once. */
export function measureFootprint(root: string): Footprint {
  const seen = new Set<string>();
  const files: { path: string; tokens: number }[] = [];
  const visit = (abs: string, hops: number) => {
    if (seen.has(abs) || !existsSync(abs) || !statSync(abs).isFile()) return;
    seen.add(abs);
    const text = readFileSync(abs, 'utf8');
    files.push({ path: relative(root, abs), tokens: estimateTokens(text) });
    if (hops === MAX_HOPS) return;
    for (const target of importsIn(text)) {
      const next = resolve(dirname(abs), target);
      // Only the repo's own files count. A ~/ or absolute import is the user's, not the harness.
      if (!target.startsWith('~') && !relative(root, next).startsWith('..')) visit(next, hops + 1);
    }
  };
  for (const start of [
    join(root, 'CLAUDE.md'),
    join(root, '.claude/CLAUDE.md'),
    ...unscopedRules(root),
  ]) {
    visit(start, 0);
  }
  return { files, total: files.reduce((sum, f) => sum + f.tokens, 0) };
}

if (import.meta.main) {
  const { files, total } = measureFootprint(join(import.meta.dirname, '..'));
  const detail = files.map((f) => `${f.path} ${f.tokens}`).join(', ');
  const line = `context footprint: ${total} / ${BUDGET_TOKENS} tokens (${detail})`;
  if (total > BUDGET_TOKENS) {
    console.error(`${line}\n  Over budget by ${total - BUDGET_TOKENS}. Move detail out of the`);
    console.error('  always-loaded files into a linked doc, or raise BUDGET_TOKENS with a reason.');
    process.exit(1);
  }
  console.log(line);
}
