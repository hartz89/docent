import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type FixtureManifest, validateManifest } from './manifest.ts';

/** The committed public core set. Private fixtures never live in this repo. */
export const PUBLIC_FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'public');

export interface FixtureSet {
  readonly manifests: readonly FixtureManifest[];
  /** One line per problem, each starting with the file name. Empty means the set is good. */
  readonly problems: readonly string[];
}

/** Reads and validates every `*.json` manifest in a folder. */
export function loadFixtures(dir: string, visibility: FixtureManifest['visibility']): FixtureSet {
  const manifests: FixtureManifest[] = [];
  const problems: string[] = [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  for (const name of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (error) {
      problems.push(`${name}: is not valid JSON (${(error as Error).message})`);
      continue;
    }
    const result = validateManifest(parsed);
    if (!result.ok) {
      for (const error of result.errors) problems.push(`${name}: ${error}`);
      continue;
    }
    const { manifest } = result;
    if (manifest.id !== basename(name, '.json')) {
      problems.push(`${name}: id is "${manifest.id}", but the file name must match it`);
    }
    if (manifest.visibility !== visibility) {
      problems.push(`${name}: visibility must be "${visibility}" in this folder`);
    }
    manifests.push(manifest);
  }
  return { manifests, problems };
}
