export type Money = number;

export type Discount = {
  code: string;
  percent: number;
  /** The smallest total, in cents, the discount applies to. */
  minimumCents: number;
};
