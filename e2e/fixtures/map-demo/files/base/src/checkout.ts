import { applyDiscount, totalOf } from './pricing.ts';
import type { Discount } from './types.ts';

type Item = { cents: number; quantity: number };

export function checkout(items: Item[], discount?: Discount) {
  const total = totalOf(items);
  return discount ? applyDiscount(total, discount) : total;
}

export function previewTotal(items: Item[], discount: Discount) {
  return applyDiscount(totalOf(items), discount);
}
