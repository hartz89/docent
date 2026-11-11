import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  buildLedger,
  type Gh,
  type Pr,
  renderReport,
  repairsIn,
  reportsProblem,
} from './trust-ledger.ts';

// Real GitHub API responses for nine PRs, recorded with `--record` on 2026-11-10 and trimmed to
// the fields the ledger reads: #1, #6, #11, #25, #29, #30, #31, #33 and #42.
const FIXTURE = new URL('./fixtures/trust-ledger-github.json', import.meta.url);
type Snapshot = Record<string, unknown>;
const R = 'repos/hartz89/docent';

function snapshot(): Snapshot {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function replay(saved: Snapshot): Gh {
  return (path) => {
    if (!(path in saved)) throw new Error(`no recorded response for ${path}`);
    return saved[path];
  };
}

const report = (saved: Snapshot) => renderReport(buildLedger(replay(saved)));
const ledger = (saved: Snapshot) => buildLedger(replay(saved));

interface RecordedPull {
  number: number;
  merged_at: string | null;
  labels: { name: string }[];
}

/** The recorded pull for one PR, to edit before replaying. */
function recordedPull(saved: Snapshot, n: number): RecordedPull {
  const pulls = saved[`${R}/pulls?state=all&per_page=100&page=1`] as RecordedPull[];
  const pull = pulls.find((p) => p.number === n);
  if (!pull) throw new Error(`#${n} isn't in the fixture`);
  return pull;
}

function prIn(prs: Pr[], n: number): Pr {
  const pr = prs.find((p) => p.number === n);
  if (!pr) throw new Error(`#${n} isn't in the ledger`);
  return pr;
}

describe('the trust ledger, from recorded GitHub history', () => {
  test('#29 escaped: fixed in #30, then both reverted in #31', () => {
    const prs = ledger(snapshot());

    expect(prIn(prs, 29).repairedBy).toEqual([
      { number: 30, how: 'fixed' },
      { number: 31, how: 'reverted' },
    ]);
    // #30 was reverted only because the PR it fixed was; that's one incident, not two.
    expect(prIn(prs, 30).repairedBy).toEqual([]);
    // #33 "fixes the gap noted in #25": #25 disclosed that gap, so nothing escaped.
    expect(prIn(prs, 25).repairedBy).toEqual([]);

    const text = report(snapshot());
    expect(text).toContain('- **Escapes:** 1 of 9 merged PRs were later reverted or fixed (11%');
    expect(text).toContain(
      '| [#29](https://github.com/hartz89/docent/pull/29) Web: wrap long lines in the code view, with a toggle | 1 | web | fixed in [#30](https://github.com/hartz89/docent/pull/30), reverted in [#31](https://github.com/hartz89/docent/pull/31) | yes |',
    );
  });

  test('counts reviewer findings, including reviews posted before the reviewer app existed', () => {
    const prs = ledger(snapshot());
    const flagged = prs.filter((p) => p.reviewerFlagged).map((p) => p.number);
    // #29: changes requested (19 seconds after merge). #42: six rounds of changes requested.
    expect(flagged).toEqual([29, 42]);
    // #6's review went through the maintainer's login and found nothing.
    expect(prIn(prs, 6)).toMatchObject({
      reviewedByAgent: true,
      reviewerFlagged: false,
    });

    expect(report(snapshot())).toContain(
      '- **Review catch rate:** the reviewer flagged problems in 2 merged PRs, and missed 0 that escaped (100% caught).',
    );
  });

  test('tiers come from the description, falling back to the backtest', () => {
    const prs = ledger(snapshot());
    expect(prs.map((p) => [p.number, p.tier, p.tierSource])).toEqual([
      [1, '2', 'description'],
      [6, '2', 'description'],
      [11, '2b', 'backtest'],
      [25, '1', 'description'],
      [29, '1', 'description'],
      [30, '1', 'description'],
      [31, '1', 'description'],
      [33, '1', 'description'],
      [42, '1', 'description'],
    ]);
    expect(report(snapshot())).toContain('| 1 | 6 | 1 | 17% | 6 | 2 | 100% | 4 |');
  });

  test('a tier label wins over the description', () => {
    const saved = snapshot();
    recordedPull(saved, 29).labels.push({ name: 'tier-2a' });
    expect(prIn(ledger(saved), 29)).toMatchObject({
      tier: '2a',
      tierSource: 'label',
    });
  });

  test("the maintainer's remark on #1, followed by more commits, counts as an override", () => {
    const text = report(snapshot());
    expect(text).toContain(
      '- **Override rate:** the maintainer changed or rejected 1 of 3 PRs that waited for him (33%).',
    );
    expect(text).toContain(
      'Land changes through GitHub PRs from worktrees | 2 | commented, then more commits followed |',
    );
  });

  test('escalations and PRs closed without merging', () => {
    const saved = snapshot();
    recordedPull(saved, 42).merged_at = null;
    const timeline = saved[`${R}/issues/42/timeline?per_page=100&page=1`] as Record<
      string,
      unknown
    >[];
    saved[`${R}/issues/42/timeline?per_page=100&page=1`] = [
      {
        event: 'labeled',
        label: { name: 'needs-maintainer' },
        created_at: '2026-11-10T05:00:00Z',
        actor: { login: 'x' },
      },
      ...timeline.filter((e) => e.event !== 'merged'),
    ];

    const text = report(saved);
    expect(text).toContain('- **Escalations:** 1 PRs labeled `needs-maintainer`, 0 still open.');
    expect(text).toContain('| 2026-11-02 | 4 | 0 |\n| 2026-11-09 | 5 | 1 |');
    expect(text).toContain(
      'Core: proven-skip detectors and the computed skip ledger | 1 | closed without merging |',
    );
  });
});

describe('reading review and PR text', () => {
  test.each([
    ['One real bug, otherwise this looks good.', true],
    ['**Verdict: fix first.** The rules engine is solid.', true],
    ['**Verdict: comment.** No must-fix. Two small should-fix contrast gaps.', true],
    ['**Verdict:** No blockers. Reviewed at 914cfa5; the should-fix items are addressed.', true],
    ['### must-fix\n\n1. The checked radio is under 3:1.', true],
    ['Verdict: no must-fix or should-fix findings. Five nits below.', false],
    ['Approving. I found no real bugs.', false],
    ['Fresh-context review. No bugs found; approving.', false],
  ])('reportsProblem(%j) is %s', (text, expected) => {
    expect(reportsProblem(text)).toBe(expected);
  });

  test.each([
    [
      'Revert line wrapping (#29, #30)',
      'Exactly the state after [#28](…).',
      [29, 30].map((number) => ({ number, how: 'reverted' })),
    ],
    ['Revert "Web: wrap"', 'Reverts hartz89/docent#29', [{ number: 29, how: 'reverted' }]],
    [
      'Web: keep tabs',
      '**Intent:** fix the bug the reviewer found in [#29](https://x).',
      [{ number: 29, how: 'fixed' }],
    ],
    ['Web: chat', 'This also fixes the gap noted in [#25](https://x).', []],
    ['Docs', 'PRs like #19 fell to 2a. Review findings were fixed.', []],
  ])('repairsIn(%j)', (title, body, expected) => {
    expect(repairsIn(title, body)).toEqual(expected);
  });
});
