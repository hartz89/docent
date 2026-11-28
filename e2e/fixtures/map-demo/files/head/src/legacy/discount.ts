// The old discount helper, kept for the v1 API. Not the one this PR changes.
export function applyDiscount(total: number, percent: number): number {
  return total - (total * percent) / 100;
}
