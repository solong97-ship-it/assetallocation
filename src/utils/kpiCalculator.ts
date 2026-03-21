import type { AssetItem, PortfolioKPI } from "../types/portfolio";

export type PricePoint = {
  date: string;
  close: number;
};

const TRADING_DAYS = 252;

function normalizeWeights(items: AssetItem[]): number[] {
  const raw = items.map((item) => Math.max(0, item.weight));
  const sum = raw.reduce((acc, cur) => acc + cur, 0);
  if (sum <= 0) return items.map(() => 0);
  return raw.map((w) => w / sum);
}

function stddev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((acc, cur) => acc + cur, 0) / values.length;
  const variance =
    values.reduce((acc, cur) => acc + (cur - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculatePortfolioKpiFromOneYearHistory(
  items: AssetItem[],
  historyByCode: Record<string, PricePoint[]>
): PortfolioKPI | null {
  if (items.length === 0) return null;

  const validItems = items.filter((item) => (historyByCode[item.code]?.length ?? 0) >= 30);
  if (validItems.length === 0) return null;

  const commonDates = new Set(historyByCode[validItems[0].code].map((p) => p.date));
  for (let i = 1; i < validItems.length; i += 1) {
    const currentDates = new Set(historyByCode[validItems[i].code].map((p) => p.date));
    for (const date of [...commonDates]) {
      if (!currentDates.has(date)) commonDates.delete(date);
    }
  }
  const sortedDates = [...commonDates].sort();
  if (sortedDates.length < 30) return null;

  const weights = normalizeWeights(validItems);
  const priceMapByCode = validItems.reduce<Record<string, Map<string, number>>>((acc, item) => {
    acc[item.code] = new Map(historyByCode[item.code].map((p) => [p.date, p.close]));
    return acc;
  }, {});

  const baseDate = sortedDates[0];
  const basePrices = validItems.map((item) => {
    const price = priceMapByCode[item.code].get(baseDate) ?? 0;
    return price > 0 ? price : 0;
  });
  if (basePrices.some((price) => price <= 0)) return null;

  const indexSeries = sortedDates.map((date) => {
    let value = 0;
    for (let i = 0; i < validItems.length; i += 1) {
      const code = validItems[i].code;
      const close = priceMapByCode[code].get(date) ?? basePrices[i];
      value += weights[i] * (close / basePrices[i]);
    }
    return value;
  });
  if (indexSeries.length < 2) return null;

  const first = indexSeries[0];
  const last = indexSeries[indexSeries.length - 1];
  if (first <= 0 || last <= 0) return null;

  const years = Math.max((indexSeries.length - 1) / TRADING_DAYS, 1 / TRADING_DAYS);
  const cagr = (Math.pow(last / first, 1 / years) - 1) * 100;

  let peak = indexSeries[0];
  let maxDrawdown = 0;
  for (const point of indexSeries) {
    if (point > peak) peak = point;
    const drawdown = peak > 0 ? ((peak - point) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const dailyReturns: number[] = [];
  for (let i = 1; i < indexSeries.length; i += 1) {
    const prev = indexSeries[i - 1];
    const next = indexSeries[i];
    if (prev <= 0) continue;
    dailyReturns.push(next / prev - 1);
  }
  if (dailyReturns.length === 0) return null;
  const meanDaily = dailyReturns.reduce((acc, cur) => acc + cur, 0) / dailyReturns.length;
  const volatility = stddev(dailyReturns);
  const sharpe = volatility > 0 ? (meanDaily / volatility) * Math.sqrt(TRADING_DAYS) : 0;

  const annualDividendYield = validItems.reduce(
    (acc, item, idx) => acc + weights[idx] * Math.max(0, item.dividendYield),
    0
  );

  return {
    cagr: round2(cagr),
    mdd: round2(maxDrawdown),
    sharpe: round2(sharpe),
    annualDividendYield: round2(annualDividendYield),
  };
}

