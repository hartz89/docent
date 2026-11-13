import { describe, expect, test } from 'vitest';
import { checkDeps } from './check-deps.ts';

describe('checkDeps', () => {
  test('passes exact versions, workspace links and permissive or excepted licenses', () => {
    const manifests = {
      'apps/server/package.json': {
        dependencies: { hono: '4.13.16', '@docent/core': 'workspace:*' },
        devDependencies: { vite: '8.3.6-beta.1' },
      },
    };
    const licenses = {
      MIT: [{ name: 'hono', versions: ['4.13.16'] }],
      'OFL-1.1': [{ name: '@fontsource-variable/newsreader', versions: ['5.3.0'] }],
      Unknown: [{ name: '@docent/core', versions: ['0.0.0'] }],
    };
    expect(checkDeps(manifests, licenses)).toEqual([]);
  });

  test('flags version ranges and unlisted licenses', () => {
    const problems = checkDeps(
      { 'package.json': { dependencies: { a: '^1.0.0' }, devDependencies: { b: '~2.0.0' } } },
      { 'GPL-3.0': [{ name: 'copyleft', versions: ['1.0.0'] }] },
    );
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/a is "\^1\.0\.0"/);
    expect(problems.join('\n')).toMatch(/b is "~2\.0\.0"/);
    expect(problems.join('\n')).toMatch(/copyleft@1\.0\.0 is licensed GPL-3\.0/);
  });
});
