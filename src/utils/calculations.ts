import type { AssetItem } from "../types/portfolio";

type ShareCalcOptions = {
  integerMode?: boolean;
  precision?: number;
};

const DEFAULT_PRECISION = 4;

const round = (value: number, precision: number): number => {
  const p = 10 ** precision;
  return Math.round((value + Number.EPSILON) * p) / p;
};

export const calcShareCount = (
  principal: number,
  weight: number,
  price: number,
  options: ShareCalcOptions = {}
): number => {
  if (price <= 0) return 0;
  const base = (principal * (weight / 100)) / price;
  if (options.integerMode) return Math.floor(base);
  return round(base, options.precision ?? DEFAULT_PRECISION);
};

export const calcCheckAmount = (price: number, quantity: number): number => {
  if (price <= 0 || quantity < 0) return 0;
  return price * quantity;
};

export const calcWeightSum = (items: AssetItem[]): number => {
  return items.reduce((sum, item) => sum + item.weight, 0);
};

export const calcSafeAssetWeight = (items: AssetItem[]): number => {
  return items
    .filter((item) => item.category === "안전자산")
    .reduce((sum, item) => sum + item.weight, 0);
};

export const calcMonthlyDividend = (
  principal: number,
  annualDividendYield: number
): number => {
  return (principal * (annualDividendYield / 100)) / 12 / 10000;
};
