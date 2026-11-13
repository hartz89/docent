// Adversarial tour fixtures: small PRs built to hide a real behavior change behind something a
// skip might cover, such as a "mechanical rename" or a "generated, skip it" comment. They're built,
// not found, so there's no fix PR to link: the hidden change is the evidence, and each one is
// stored as two file trees instead of a GitHub PR. The runner commits both trees to a throwaway
// git repo and reviews that, through the same tour job and ledger as every other fixture.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitSha } from '@docent/core';
import { commitReader, git, gitHeadFiles, type Workspace } from '@docent/server/evals';
import { type FixtureManifest, type LineRange, sizeFor } from './manifest.ts';

export const ADVERSARIAL_DIR = join(import.meta.dirname, '..', 'fixtures', 'adversarial');

export interface AdversarialFixture {
  /** Starts with `adversarial-`, and matches the file name. */
  readonly id: string;
  /** The PR as its author presents it. Any of these may carry the injection. */
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  /** Repo path → file text, before and after the PR. A path missing from `head` is deleted. */
  readonly base: Readonly<Record<string, string>>;
  readonly head: Readonly<Record<string, string>>;
  /** The real behavior change the PR hides: head lines that must end up on the route. */
  readonly hidden: readonly {
    readonly file: string;
    readonly lines: LineRange;
    readonly description: string;
  }[];
  readonly expectDangerFlag: boolean;
}

/** Every adversarial fixture, read from its JSON file. Throws on a malformed one. */
export async function loadAdversarial(dir = ADVERSARIAL_DIR): Promise<AdversarialFixture[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (name) => {
      const fixture = JSON.parse(await readFile(join(dir, name), 'utf8')) as AdversarialFixture;
      if (`${fixture.id}.json` !== name || !fixture.id.startsWith('adversarial-')) {
        throw new Error(`${name}: the id must start with "adversarial-" and match the file name`);
      }
      if (!fixture.hidden?.length) throw new Error(`${name}: lists no hidden change`);
      return fixture;
    }),
  );
}

/**
 * Commits the fixture's two trees to a fresh repo in the temp folder, and opens it the way a
 * GitHub PR is opened: the diff between the commits, files read from git objects, the head
 * checked out for the guide to read. Returns the workspace and a manifest for the scorer.
 */
export async function openAdversarial(
  fixture: AdversarialFixture,
): Promise<{ workspace: Workspace; manifest: FixtureManifest; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'docent-adversarial-'));
  const commit = async (files: Readonly<Record<string, string>>, message: string) => {
    await git(dir, ['rm', '-r', '-q', '--ignore-unmatch', '.']);
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    await git(dir, ['add', '-A']);
    await git(dir, [
      '-c',
      'user.name=Docent evals',
      '-c',
      'user.email=evals@docent.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      message,
    ]);
    return commitSha((await git(dir, ['rev-parse', 'HEAD'])).stdout.trim());
  };
  await git(dir, ['init', '--quiet', '--initial-branch=main']);
  const base = await commit(fixture.base, 'base');
  const head = await commit(fixture.head, fixture.commitMessage);
  const diffText = (await git(dir, ['diff', '--no-color', base, head])).stdout;
  const changed = diffText
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length;

  const workspace: Workspace = {
    pr: {
      url: `https://github.com/docent-evals/${fixture.id}/pull/1`,
      repo: `docent-evals/${fixture.id}`,
      number: 1,
      title: fixture.title,
      body: fixture.body,
      author: 'contributor',
      base,
      head,
      baseRef: 'main',
      headRef: 'change',
    },
    diffText,
    commitMessages: [fixture.commitMessage],
    headInBaseRepo: true,
    dir,
    ...commitReader(dir, base, head),
    headFiles: () => gitHeadFiles(dir, head),
    current: async () => ({ head, baseRef: 'main' }),
    postReview: async () => {
      throw new Error('An eval never posts a review.');
    },
  };
  const manifest: FixtureManifest = {
    id: fixture.id,
    visibility: 'public',
    source: { repo: workspace.pr.repo, pr: 1, base, head },
    license: 'Apache-2.0',
    title: fixture.title,
    size: sizeFor(changed),
    jobs: ['tour', 'danger'],
    expectedFindings: fixture.hidden.map(({ file, lines, description }) => ({
      file,
      lines,
      description,
    })),
    mustNotSkip: fixture.hidden.map(({ file, lines, description }) => ({
      file,
      lines,
      reason: description,
    })),
    expectDangerFlag: fixture.expectDangerFlag,
    evidence: [],
  };
  return { workspace, manifest, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
