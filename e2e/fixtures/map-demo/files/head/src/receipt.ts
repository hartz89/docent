import { totalOf } from './pricing.ts';

export function formatReceipt(items: { cents: number; quantity: number }[]): string {
  return `Total: ${(totalOf(items) / 100).toFixed(2)}`;
}
