/** K1: every kind of model call Docent makes. A closed list, so a typo is a type error. */
export const JOBS = [
  'tour',
  'skip_decision',
  'danger_flag',
  'answer_check',
  'scrub',
  'question',
  'revision',
] as const;
export type Job = (typeof JOBS)[number];

export type Tokens = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

/** One model call (K1). Cost is in whole micro-dollars, so sums are exact (K2). */
export type CostRecord = {
  readonly job: Job;
  readonly model: string;
  readonly tokens: Tokens;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
};

export type JobTotal = {
  readonly job: Job;
  readonly calls: number;
  readonly tokens: Tokens;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
};

/** K3, K4: totals per job, in the order of JOBS. Jobs with no records are left out. */
export function costByJob(records: readonly CostRecord[]): JobTotal[] {
  const totals = new Map<Job, JobTotal>();
  for (const record of records) {
    const sum = totals.get(record.job);
    totals.set(record.job, {
      job: record.job,
      calls: (sum?.calls ?? 0) + 1,
      tokens: {
        input: (sum?.tokens.input ?? 0) + record.tokens.input,
        output: (sum?.tokens.output ?? 0) + record.tokens.output,
        cacheRead: (sum?.tokens.cacheRead ?? 0) + record.tokens.cacheRead,
        cacheWrite: (sum?.tokens.cacheWrite ?? 0) + record.tokens.cacheWrite,
      },
      costMicroUsd: (sum?.costMicroUsd ?? 0) + record.costMicroUsd,
      latencyMs: (sum?.latencyMs ?? 0) + record.latencyMs,
    });
  }
  return JOBS.flatMap((job) => totals.get(job) ?? []);
}
