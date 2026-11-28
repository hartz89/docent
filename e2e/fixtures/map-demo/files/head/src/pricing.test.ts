import { applyDiscount, totalOf } from './pricing.ts';

const tenOff = { code: 'TEN', percent: 10, minimumCents: 500 };
console.assert(applyDiscount(1000, tenOff) === 900);
console.assert(applyDiscount(400, tenOff) === 400);
console.assert(totalOf([{ cents: 250, quantity: 2 }]) === 500);
