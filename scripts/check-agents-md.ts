// Checks the AGENTS.md / CLAUDE.md pairing that makes Claude Code load every AGENTS.md.
// Rule: every folder with an AGENTS.md has a CLAUDE.md beside it that imports it.
// The root CLAUDE.md starts with "@AGENTS.md" and may add Claude-only notes; every
// other CLAUDE.md is exactly "@AGENTS.md". Why: docs/research/2026-11-06-context-loading.md
// Run: node scripts/check-agents-md.ts (part of pnpm verify).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const IMPORT_LINE = '@AGENTS.md';

/** Folders that never hold this repo's instructions: dependencies, git, other worktrees. */
function isSkipped(dirFromRoot: string, name: string): boolean {
  return (
    name === 'node_modules' || name === '.git' || join(dirFromRoot, name) === '.claude/worktrees'
  );
}

/** Every folder under root (relative paths, '' for root) with the instruction files it holds. */
function instructionFolders(root: string): Map<string, { agents: boolean; claude: boolean }> {
  const found = new Map<string, { agents: boolean; claude: boolean }>();
  const walk = (dir: string) => {
    const here = { agents: false, claude: false };
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!isSkipped(dir, entry.name)) walk(join(dir, entry.name));
      } else if (entry.name === 'AGENTS.md') {
        here.agents = true;
      } else if (entry.name === 'CLAUDE.md') {
        here.claude = true;
      }
    }
    if (here.agents || here.claude) found.set(dir, here);
  };
  walk('');
  return found;
}

/** Returns one short message per problem. An empty list means the tree is good. */
export function checkAgentsMd(root: string): string[] {
  const problems: string[] = [];
  for (const [dir, { agents, claude }] of instructionFolders(root)) {
    const agentsPath = join(dir, 'AGENTS.md');
    const claudePath = join(dir, 'CLAUDE.md');
    if (!claude) {
      problems.push(
        `${agentsPath} has no CLAUDE.md beside it. Add ${claudePath} containing exactly "${IMPORT_LINE}".`,
      );
      continue;
    }
    if (!agents) {
      problems.push(
        `${claudePath} has no AGENTS.md beside it. Put the notes in ${agentsPath} and make ${claudePath} contain exactly "${IMPORT_LINE}".`,
      );
      continue;
    }
    const text = readFileSync(join(root, claudePath), 'utf8');
    if (dir === '') {
      if (text.split('\n')[0] !== IMPORT_LINE) {
        problems.push(`CLAUDE.md must start with a "${IMPORT_LINE}" line.`);
      }
    } else if (text !== IMPORT_LINE && text !== `${IMPORT_LINE}\n`) {
      problems.push(
        `${claudePath} must contain exactly "${IMPORT_LINE}". Move anything else into ${agentsPath}.`,
      );
    }
  }
  return problems.sort();
}

if (import.meta.main) {
  const root = join(import.meta.dirname, '..');
  const problems = checkAgentsMd(root);
  if (problems.length > 0) {
    console.error(
      `check-agents-md: ${problems.length} problem(s) in ${relative(process.cwd(), root) || '.'}`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}
