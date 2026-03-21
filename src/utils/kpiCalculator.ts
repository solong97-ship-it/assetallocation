import type { AssetItem, PortfolioKPI } from "../types/portfolio";

export type PricePoint = {
  date: string;
  close: number;
};

const TRADING_DAYS = 252;
export type KpiWindow = "1Y" | "6M" | "3M" | "1M";

export const KPI_WINDOW_LABELS: Record<KpiWindow, string> = {
  "1Y": "1년",
  "6M": "6개월",
  "3M": "3개월",
  "1M": "1개월",
};

export const KPI_WINDOW_MAX_POINTS: Record<KpiWindow, number> = {
  "1Y": 252,
  "6M": 126,
  "3M": 63,
  "1M": 21,
};

export const KPI_WINDOW_MIN_POINTS: Record<KpiWindow, number> = {
  "1Y": 30,
  "6M": 30,
  "3M": 30,
  "1M": 15,
};

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

export function calculatePortfolioKpiFromHistoryWindow(
  items: AssetItem[],
  historyByCode: Record<string, PricePoint[]>,
  window: KpiWindow
): PortfolioKPI | null {
  if (items.length === 0) return null;

  const minRequiredPoints = KPI_WINDOW_MIN_POINTS[window];
  const validItems = items.filter(
    (item) => (historyByCode[item.code]?.length ?? 0) >= minRequiredPoints
  );
  if (validItems.length === 0) return null;

  const commonDates = new Set(historyByCode[validItems[0].code].map((p) => p.date));
  for (let i = 1; i < validItems.length; i += 1) {
    const currentDates = new Set(historyByCode[validItems[i].code].map((p) => p.date));
    for (const date of [...commonDates]) {
      if (!currentDates.has(date)) commonDates.delete(date);
    }
  }
  const sortedDates = [...commonDates].sort();
  if (sortedDates.length < minRequiredPoints) return null;
  const maxPoints = KPI_WINDOW_MAX_POINTS[window];
  const slicedDates = sortedDates.slice(-Math.min(sortedDates.length, maxPoints));
  if (slicedDates.length < minRequiredPoints) return null;

  const weights = normalizeWeights(validItems);
  const priceMapByCode = validItems.reduce<Record<string, Map<string, number>>>((acc, item) => {
    acc[item.code] = new Map(historyByCode[item.code].map((p) => [p.date, p.close]));
    return acc;
  }, {});

  const baseDate = slicedDates[0];
  const basePrices = validItems.map((item) => {
    const price = priceMapByCode[item.code].get(baseDate) ?? 0;
    return price > 0 ? price : 0;
  });
  if (basePrices.some((price) => price <= 0)) return null;

  const indexSeries = slicedDates.map((date) => {
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

  const annualDividendYield = validItems.reduce(
    (acc, item, idx) => acc + weights[idx] * Math.max(0, item.dividendYield),
    0
  );
  const dailyDividendRate = annualDividendYield / 100 / TRADING_DAYS;

  // CAGR은 배당 재투자(일 단위 근사)를 반영한 총수익 인덱스로 계산한다.
  const totalReturnSeries: number[] = [1];
  for (let i = 1; i < indexSeries.length; i += 1) {
    const prev = indexSeries[i - 1];
    const next = indexSeries[i];
    if (prev <= 0 || next <= 0) {
      totalReturnSeries.push(totalReturnSeries[totalReturnSeries.length - 1]);
      continue;
    }
    const priceReturn = next / prev - 1;
    const totalReturn = (1 + priceReturn) * (1 + dailyDividendRate) - 1;
    totalReturnSeries.push(
      totalReturnSeries[totalReturnSeries.length - 1] * (1 + totalReturn)
    );
  }

  const years = Math.max((indexSeries.length - 1) / TRADING_DAYS, 1 / TRADING_DAYS);
  const totalFirst = totalReturnSeries[0];
  const totalLast = totalReturnSeries[totalReturnSeries.length - 1];
  const cagr = totalFirst > 0 && totalLast > 0
    ? (Math.pow(totalLast / totalFirst, 1 / years) - 1) * 100
    : 0;

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

  return {
    cagr: round2(cagr),
    mdd: round2(maxDrawdown),
    sharpe: round2(sharpe),
    annualDividendYield: round2(annualDividendYield),
  };
}

export function calculatePortfolioKpiFromOneYearHistory(
  items: AssetItem[],
  historyByCode: Record<string, PricePoint[]>
): PortfolioKPI | null {
  return calculatePortfolioKpiFromHistoryWindow(items, historyByCode, "1Y");
}
