import { applyDiscount } from '../pricing.ts';
import { WELCOME } from '../promo.ts';

export function createOrder(cents: number, firstOrder: boolean) {
  const charged = firstOrder ? applyDiscount(cents, WELCOME) : cents;
  return { charged };
}
