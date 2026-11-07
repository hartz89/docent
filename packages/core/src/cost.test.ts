import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { type CostRecord, costByJob, JOBS, type JobTotal } from './cost.ts';

const count = fc.nat({ max: 1_000_000 });
const record: fc.Arbitrary<CostRecord> = fc.record({
  job: fc.constantFrom(...JOBS),
  model: fc.constantFrom('opus', 'haiku'),
  tokens: fc.record({ input: count, output: count, cacheRead: count, cacheWrite: count }),
  costMicroUsd: count,
  latencyMs: count,
});
const records = fc.array(record, { maxLength: 30 });

/** One record's own totals. */
const single = ({ job, tokens, costMicroUsd, latencyMs }: CostRecord): JobTotal[] => [
  { job, calls: 1, tokens, costMicroUsd, latencyMs },
];

/** Adds two sets of per-job totals together. */
function merge(a: readonly JobTotal[], b: readonly JobTotal[]): JobTotal[] {
  return JOBS.flatMap((job) => {
    const [x, y] = [a.find((t) => t.job === job), b.find((t) => t.job === job)];
    if (!x || !y) return x ?? y ?? [];
    return [
      {
        job,
        calls: x.calls + y.calls,
        tokens: {
          input: x.tokens.input + y.tokens.input,
          output: x.tokens.output + y.tokens.output,
          cacheRead: x.tokens.cacheRead + y.tokens.cacheRead,
          cacheWrite: x.tokens.cacheWrite + y.tokens.cacheWrite,
        },
        costMicroUsd: x.costMicroUsd + y.costMicroUsd,
        latencyMs: x.latencyMs + y.latencyMs,
      },
    ];
  });
}

describe('costByJob', () => {
  test('K2, K3: each job present gets its call count and exact totals; absent jobs are left out', () => {
    fc.assert(
      fc.property(records, (rs) => {
        const totals = costByJob(rs);
        expect(totals.map((t) => t.job)).toEqual(
          JOBS.filter((job) => rs.some((r) => r.job === job)),
        );
        for (const total of totals) {
          const singles = rs.filter((r) => r.job === total.job).map(single);
          expect([total]).toEqual(singles.reduce(merge, []));
        }
      }),
    );
  });

  test('K4: order does not matter, and summing in parts gives the same totals', () => {
    fc.assert(
      fc.property(records, records, (a, b) => {
        expect(costByJob([...b, ...a])).toEqual(costByJob([...a, ...b]));
        expect(merge(costByJob(a), costByJob(b))).toEqual(costByJob([...a, ...b]));
      }),
    );
  });

  test('K3: no records, no totals', () => {
    expect(costByJob([])).toEqual([]);
  });
});
