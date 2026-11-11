// Checks what Docent depends on, since it ships to users through npx:
// - every dependency in every workspace package.json is pinned to an exact version;
// - every production dependency, direct or not, has a permissive license, or a named exception.
// Run: node scripts/check-deps.ts (part of pnpm verify). Reads the installed tree, no network.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);

/**
 * Packages allowed under another license, each with the reason. A new package with an unusual
 * license fails the check until someone adds it here and says why it's fine.
 */
export const LICENSE_EXCEPTIONS: Record<string, string> = {
  '@anthropic-ai/claude-agent-sdk':
    "Anthropic's own terms (SEE LICENSE IN README.md). Docent's model boundary; installed from npm, never bundled.",
  '@anthropic-ai/claude-agent-sdk-darwin-arm64':
    'Same terms as the Agent SDK: its platform binary.',
  '@anthropic-ai/claude-agent-sdk-darwin-x64': 'Same terms as the Agent SDK: its platform binary.',
  '@anthropic-ai/claude-agent-sdk-linux-arm64': 'Same terms as the Agent SDK: its platform binary.',
  '@anthropic-ai/claude-agent-sdk-linux-arm64-musl':
    'Same terms as the Agent SDK: its platform binary.',
  '@anthropic-ai/claude-agent-sdk-linux-x64': 'Same terms as the Agent SDK: its platform binary.',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl':
    'Same terms as the Agent SDK: its platform binary.',
  '@anthropic-ai/claude-agent-sdk-win32-arm64': 'Same terms as the Agent SDK: its platform binary.',
  '@anthropic-ai/claude-agent-sdk-win32-x64': 'Same terms as the Agent SDK: its platform binary.',
  '@fontsource-variable/instrument-sans':
    'SIL OFL 1.1: fonts may be bundled with software; the license ships in THIRD_PARTY_LICENSES.md.',
  '@fontsource-variable/jetbrains-mono': 'SIL OFL 1.1, as above.',
  '@fontsource-variable/newsreader': 'SIL OFL 1.1, as above.',
  'fast-sha256': 'Unlicense: public domain dedication.',
  isbot: 'Unlicense: public domain dedication.',
};

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type LicenseEntry = { name: string; versions: string[] };

/**
 * One message per package whose license isn't permissive or excepted. `scripts/pack.ts` runs it too,
 * over the shrinkwrap npm resolves, since that tree is the one users install.
 */
export function licenseProblems(
  packages: readonly { name: string; version: string; license: string }[],
): string[] {
  return packages
    .filter(({ name, license }) => !PERMISSIVE.has(license) && !(name in LICENSE_EXCEPTIONS))
    .map(
      ({ name, version, license }) =>
        `${name}@${version} is licensed ${license}. Replace it, or add it to LICENSE_EXCEPTIONS in scripts/check-deps.ts with the reason it's fine.`,
    );
}

/** Returns one short message per problem. An empty list means everything is pinned and permitted. */
export function checkDeps(
  manifests: Record<string, Manifest>,
  licenses: Record<string, LicenseEntry[]>,
): string[] {
  const problems: string[] = [];
  for (const [path, manifest] of Object.entries(manifests)) {
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (version !== 'workspace:*' && !EXACT.test(version)) {
          problems.push(`${path}: ${name} is "${version}". Pin an exact version, like "1.2.3".`);
        }
      }
    }
  }
  // The workspace's own @docent/* packages have no license field and never ship as packages.
  // Only this check skips them: on npm, nobody owns the @docent scope yet.
  const packages = Object.entries(licenses).flatMap(([license, entries]) =>
    entries
      .filter((entry) => !entry.name.startsWith('@docent/'))
      .map((entry) => ({ name: entry.name, version: entry.versions.join(','), license })),
  );
  problems.push(...licenseProblems(packages));
  return problems.sort();
}

if (import.meta.main) {
  const root = join(import.meta.dirname, '..');
  const manifests: Record<string, Manifest> = {};
  for (const dir of [
    '.',
    ...['apps', 'packages'].flatMap((group) =>
      readdirSync(join(root, group)).map((name) => `${group}/${name}`),
    ),
  ]) {
    const path = join(dir, 'package.json');
    if (existsSync(join(root, path))) {
      manifests[path] = JSON.parse(readFileSync(join(root, path), 'utf8'));
    }
  }
  const licenses = JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '--recursive'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ) as Record<string, LicenseEntry[]>;
  const problems = checkDeps(manifests, licenses);
  if (problems.length > 0) {
    console.error(`check-deps: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}
