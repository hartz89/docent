import { describe, expect, test } from 'vitest';
import { explainGhFailure } from './github.ts';

// Shapes copied from real `gh api` failures: the response body on stdout, a summary on stderr.
describe('explainGhFailure', () => {
  test('a missing gh, or a missing login, says how to fix it', () => {
    expect(explainGhFailure({ code: 'ENOENT' })).toMatch(/isn't installed/);
    expect(
      explainGhFailure({
        code: 4,
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
      }),
    ).toMatch(/isn't signed in/);
    expect(
      explainGhFailure({
        stdout: '{"message":"Bad credentials"}',
        stderr: 'gh: Bad credentials (HTTP 401)',
      }),
    ).toMatch(/isn't signed in/);
  });

  test('approving your own PR points to Comment instead', () => {
    const stdout = JSON.stringify({
      message: 'Unprocessable Entity',
      errors: ['Can not approve your own pull request'],
    });

    expect(explainGhFailure({ stdout, stderr: 'gh: Unprocessable Entity (HTTP 422)' })).toBe(
      "GitHub doesn't let you approve your own pull request. Choose Comment instead.",
    );
  });

  test("anything else passes on GitHub's own words", () => {
    const stdout = JSON.stringify({
      message: 'Unprocessable Entity',
      errors: ['Review body is too long'],
    });

    expect(explainGhFailure({ stdout, stderr: 'gh: Unprocessable Entity (HTTP 422)' })).toBe(
      "GitHub didn't accept the review: Review body is too long",
    );
  });
});
