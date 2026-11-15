import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { compareVersions, findClaudeCode, MIN_CLAUDE_CODE_VERSION } from './claude-code.ts';
import { fakeClaudeDir } from './testdata/fake-claude.ts';

describe('finding Claude Code', () => {
  test('uses the first claude on PATH, and reports its version', async () => {
    const [first, second] = [await fakeClaudeDir('3.0.0 (Claude Code)'), await fakeClaudeDir()];

    await expect(findClaudeCode({ PATH: `${first}:${second}` })).resolves.toEqual({
      path: join(first, 'claude'),
      version: '3.0.0',
    });
  });

  test('skips relative PATH entries, so the folder Docent runs from never supplies it', async () => {
    const real = await fakeClaudeDir();

    const found = await findClaudeCode({ PATH: `.:node_modules/.bin::${real}` });

    expect(found.path).toBe(join(real, 'claude'));
  });

  test('DOCENT_CLAUDE_PATH wins over PATH', async () => {
    const [onPath, chosen] = [await fakeClaudeDir(), await fakeClaudeDir('2.9.0 (Claude Code)')];

    const found = await findClaudeCode({
      PATH: onPath,
      DOCENT_CLAUDE_PATH: join(chosen, 'claude'),
    });

    expect(found).toEqual({ path: join(chosen, 'claude'), version: '2.9.0' });
  });

  test('DOCENT_CLAUDE_PATH must be an absolute path to an executable', async () => {
    const dir = await fakeClaudeDir();

    await expect(findClaudeCode({ DOCENT_CLAUDE_PATH: 'bin/claude' })).rejects.toThrow(
      'must be an absolute path',
    );
    await expect(findClaudeCode({ DOCENT_CLAUDE_PATH: dir })).rejects.toThrow(
      "isn't an executable file",
    );
  });

  test('says how to install it when there is none', async () => {
    const empty = await fakeClaudeDir();

    await expect(findClaudeCode({ PATH: join(empty, 'nothing-here') })).rejects.toThrow(
      /no `claude` on your PATH\. Install it from https:\/\/code\.claude\.com.*DOCENT_CLAUDE_PATH/,
    );
  });

  test('refuses a version older than the SDK was built with, and says how to update', async () => {
    const old = await fakeClaudeDir('2.0.99 (Claude Code)');

    await expect(findClaudeCode({ PATH: old })).rejects.toThrow(
      `Docent needs Claude Code ${MIN_CLAUDE_CODE_VERSION} or newer, and ${join(old, 'claude')} is 2.0.99. Update it with \`claude update\`.`,
    );
  });

  test('refuses a binary that does not print a version', async () => {
    const other = await fakeClaudeDir('hello');

    await expect(findClaudeCode({ PATH: other })).rejects.toThrow("doesn't look like Claude Code");
  });

  test('the minimum is the Claude Code this Agent SDK release was built with', () => {
    // The SDK passes the read-only flags to whichever binary runs. If the SDK is bumped, bump
    // the minimum with it, so an older CLI can't meet a flag it doesn't know.
    const sdk = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const { claudeCodeVersion } = JSON.parse(
      readFileSync(join(sdk, '..', 'package.json'), 'utf8'),
    ) as { claudeCodeVersion: string };

    expect(MIN_CLAUDE_CODE_VERSION).toBe(claudeCodeVersion);
  });

  test('compares versions part by part, as numbers', () => {
    expect(compareVersions('2.1.318', '2.1.318')).toBe(0);
    expect(compareVersions('2.1.325', '2.1.318')).toBeGreaterThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.999', '2.1.0')).toBeLessThan(0);
  });
});
