import type { Discount, Money } from './types.ts';

export function roundCents(value: number): Money {
  return Math.round(value);
}

export function applyDiscount(total: Money, discount: Discount): Money {
  if (total < discount.minimumCents) return total;
  return roundCents(total * (1 - discount.percent / 100));
}

export function totalOf(items: readonly { cents: Money; quantity: number }[]): Money {
  return items.reduce((sum, item) => sum + item.cents * item.quantity, 0);
}
