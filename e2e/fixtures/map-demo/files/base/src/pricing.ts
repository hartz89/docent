import type { Discount, Money } from './types.ts';

export function roundCents(value: number): Money {
  return Math.round(value);
}

export function applyDiscount(total: Money, discount: Discount): Money {
  return roundCents(total * (1 - discount.percent / 100));
}

export function totalOf(items: readonly { cents: Money; quantity: number }[]): Money {
  let sum = 0;
  for (const item of items) sum += item.cents * item.quantity;
  return sum;
}
