import { applyDiscount, totalOf } from './pricing.ts';

const tenOff = { code: 'TEN', percent: 10 };
console.assert(applyDiscount(1000, tenOff) === 900);
console.assert(totalOf([{ cents: 250, quantity: 2 }]) === 500);
