import { totalOf } from './pricing.ts';

export class Cart {
  items: { cents: number; quantity: number }[] = [];

  subtotal() {
    return totalOf(this.items);
  }
}
