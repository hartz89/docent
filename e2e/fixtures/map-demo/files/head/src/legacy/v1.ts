import { applyDiscount } from './discount.ts';

export function v1Price(total: number) {
  return applyDiscount(total, 5);
}
