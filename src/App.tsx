import { useEffect, useMemo, useRef, useState } from "react";
import { initialPortfolios, portfolioModePresets, type PortfolioMode } from "./data/portfolios";
import type { AssetItem, Portfolio, PortfolioKPI } from "./types/portfolio";
import { calcCheckAmount, calcShareCount, calcWeightSum } from "./utils/calculations";
import {
  fetchDividendYieldsByCodes,
  fetchOneYearHistoriesByCodes,
  fetchPricesByCodes,
  type PricePoint,
} from "./utils/priceFetcher";
import { formatCurrencyKRW, formatNumber, formatPercent } from "./utils/formatters";
import { sanitizeNonNegativeNumber } from "./utils/portfolioSanitizer";
import {
  KPI_WINDOW_LABELS,
  KPI_WINDOW_MAX_POINTS,
  KPI_WINDOW_MIN_POINTS,
  calculatePortfolioKpiFromHistoryWindow,
  type KpiWindow,
} from "./utils/kpiCalculator";
import {
  getStoredHistoriesByCodes,
  getStoredLatestQuotesByCodes,
  getStoredDividendYieldsByCodes,
  isStoredDividendYieldFresh,
  isStoredHistoryFresh,
  isStoredLatestQuoteFresh,
  upsertStoredDividendYields,
  upsertStoredHistories,
  upsertStoredLatestQuotes,
} from "./utils/marketDataStore";
import {
  findOptimalPortfolios,
  OPTIMIZER_ALL_CODES,
  type OptimalResult,
} from "./utils/portfolioOptimizer";

type StrategyType = "A" | "B" | "C" | "D" | "E";
type RefreshStage = "idle" | "price" | "kpi" | "done" | "error";

type SelectionState = {
  principal: number;
  strategy: StrategyType;
  mode: PortfolioMode | null;
  kpiWindow: KpiWindow;
};

type AppliedSelection = {
  principal: number;
  strategy: StrategyType;
  mode: PortfolioMode | null;
  kpiWindow: KpiWindow;
};

type StrategyComparisonRow = {
  id: string;
  label: string;
  strategy: string;
  mode: PortfolioMode | null;
  kpi: PortfolioKPI | null;
  monthlyDividend: number | null;
  periodStart: string | null;
  periodEnd: string | null;
};

type StrategyCompareMode = "ABCDE" | "A_MODES" | "B_MODES" | "A_GROWTH_SP500";

type CompoundProjectionPoint = {
  year: number;
  totalAsset: number;
  principalSum: number;
  profit: number;
};

type RefreshState = {
  stage: RefreshStage;
  totalCodes: number;
  priceDone: number;
  priceSuccess: number;
  priceFailed: number;
  priceAppliedDate: string | null;
  kpiDone: number;
  kpiSuccess: number;
  kpiFailed: number;
  currentName: string | null;
  lastUpdatedAt: string | null;
};

const strategyIds: Record<StrategyType, string> = {
  A: "A형_K_연금저축",
  B: "B형_K_IRP",
  C: "C형_DRC성장",
  D: "D형_DRC은퇴",
  E: "E형_DRC배당",
};

const strategyDescriptions: Record<StrategyType, string> = {
  A: "연금저축형, 주식/채권 균형 운용",
  B: "IRP형, A형 대비 채권·혼합 비중 조정",
  C: "성장형, 글로벌 주식 + 금 분산",
  D: "은퇴형, 커버드콜·혼합으로 현금흐름 강화",
  E: "배당형, 배당/리츠 중심 인컴 전략",
};
const STRATEGY_LIST: StrategyType[] = ["A", "B", "C", "D", "E"];
const KPI_WINDOW_LIST: KpiWindow[] = ["1Y", "6M", "3M", "1M"];
const PRINCIPAL_QUICK_ADD = [
  { label: "백만", amount: 1_000_000 },
  { label: "천만", amount: 10_000_000 },
  { label: "억", amount: 100_000_000 },
] as const;
const COMPOUND_INITIAL_QUICK_ADD = PRINCIPAL_QUICK_ADD;
const COMPOUND_ANNUAL_QUICK_ADD = [
  { label: "백만", amount: 1_000_000 },
  { label: "천만", amount: 10_000_000 },
] as const;

const STARTUP_PRICE_MAX_AGE_MS = 2 * 60 * 1000;
const RUNTIME_PRICE_MAX_AGE_MS = 60 * 1000;
const HISTORY_STALE_DAYS = 4;
const DIVIDEND_STALE_DAYS = 14;
const SP500_BENCHMARK_CODE = "379800";
const SP500_BENCHMARK_NAME = "KODEX 미국S&P500";
const SP500_BENCHMARK_DISPLAY = "S&P500";
const PRODUCED_BY_LABEL = "© 2026 DRC. All rights reserved.";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createInitialRefreshState(): RefreshState {
  return {
    stage: "idle",
    totalCodes: 0,
    priceDone: 0,
    priceSuccess: 0,
    priceFailed: 0,
    priceAppliedDate: null,
    kpiDone: 0,
    kpiSuccess: 0,
    kpiFailed: 0,
    currentName: null,
    lastUpdatedAt: null,
  };
}

function getPortfolioByStrategy(strategy: StrategyType): Portfolio {
  const id = strategyIds[strategy];
  const base = initialPortfolios.find((portfolio) => portfolio.id === id);
  if (!base) throw new Error(`portfolio not found: ${strategy}`);
  return deepClone(base);
}

function applyModeWeights(
  items: AssetItem[],
  strategy: StrategyType,
  mode: PortfolioMode | null
): AssetItem[] {
  if ((strategy !== "A" && strategy !== "B") || !mode) return items;
  const id = strategyIds[strategy];
  const preset = portfolioModePresets[id]?.[mode];
  if (!preset) return items;
  return items.map((item, index) => ({
    ...item,
    weight: preset[index] ?? item.weight,
  }));
}

function createConfiguredPortfolio(selection: SelectionState): Portfolio {
  const base = getPortfolioByStrategy(selection.strategy);
  const principal = sanitizeNonNegativeNumber(selection.principal, 0);
  return {
    ...base,
    principal,
    name:
      selection.strategy === "A" || selection.strategy === "B"
        ? `${selection.strategy}형 (${selection.mode ?? "선택안됨"})`
        : `${selection.strategy}형`,
    items: applyModeWeights(base.items, selection.strategy, selection.mode),
  };
}

function createSp500OnlyPortfolio(principal: number): Portfolio {
  const template =
    initialPortfolios
      .flatMap((portfolio) => portfolio.items)
      .find((item) => item.code === SP500_BENCHMARK_CODE) ??
    initialPortfolios[0]?.items[0];

  if (!template) {
    throw new Error("S&P500 benchmark item not found");
  }

  return {
    id: "BM_KODEX_SP500_100",
    name: SP500_BENCHMARK_DISPLAY,
    principalLabel: "투자금",
    principal,
    items: [
      {
        ...template,
        id: "bm-sp500-only",
        name: SP500_BENCHMARK_NAME,
        weight: 100,
      },
    ],
    kpi: {
      cagr: 0,
      mdd: 0,
      sharpe: 0,
      annualDividendYield: template.dividendYield,
    },
  };
}

function uniqueCodesFromItems(items: AssetItem[]): string[] {
  return [...new Set(items.map((item) => item.code))];
}

function applyPriceMapToPortfolio(portfolio: Portfolio, pricesByCode: Record<string, number>): Portfolio {
  return {
    ...portfolio,
    items: portfolio.items.map((item) => {
      const nextPrice = pricesByCode[item.code];
      if (!Number.isFinite(nextPrice) || nextPrice <= 0) return item;
      return { ...item, price: nextPrice };
    }),
  };
}

function applyDividendYieldMapToPortfolio(
  portfolio: Portfolio,
  dividendYieldByCode: Record<string, number>
): Portfolio {
  return {
    ...portfolio,
    items: portfolio.items.map((item) => {
      const nextDividendYield = dividendYieldByCode[item.code];
      if (!Number.isFinite(nextDividendYield) || nextDividendYield < 0) return item;
      return { ...item, dividendYield: nextDividendYield };
    }),
  };
}

function calculateWindowPeriodReturn(
  points: PricePoint[] | undefined,
  window: KpiWindow
): number | null {
  if (!points || points.length === 0) return null;
  const minRequiredPoints = KPI_WINDOW_MIN_POINTS[window];
  if (points.length < minRequiredPoints) return null;
  const maxPoints = KPI_WINDOW_MAX_POINTS[window];
  const sliced = points.slice(-Math.min(points.length, maxPoints));
  if (sliced.length < minRequiredPoints) return null;
  const first = sliced[0]?.close ?? 0;
  const last = sliced[sliced.length - 1]?.close ?? 0;
  if (first <= 0 || last <= 0 || sliced.length < 2) return null;
  const periodReturn = ((last / first) - 1) * 100;
  if (!Number.isFinite(periodReturn)) return null;
  return periodReturn;
}

function formatYmdFromDate(value: Date): string {
  return `${value.getFullYear()}.${String(value.getMonth() + 1).padStart(2, "0")}.${String(
    value.getDate()
  ).padStart(2, "0")}`;
}

function formatYmdFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return formatYmdFromDate(new Date(ts));
}

function formatYmdFromDashDate(value: string): string {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${year}.${month}.${day}`;
}

function getAppliedPriceDateFromQuotes(
  quotes: Record<string, { fetchedAt: string }>
): string | null {
  let latestTs = Number.NEGATIVE_INFINITY;
  for (const quote of Object.values(quotes)) {
    const ts = Date.parse(quote.fetchedAt);
    if (Number.isFinite(ts) && ts > latestTs) latestTs = ts;
  }
  if (!Number.isFinite(latestTs)) return null;
  return formatYmdFromDate(new Date(latestTs));
}

function formatSignedCurrencyKRW(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatCurrencyKRW(Math.abs(value))}`;
}

function withDividendReinvestedCagr(kpi: PortfolioKPI | null): PortfolioKPI | null {
  if (!kpi) return null;
  const baseCagr = Math.max(-99.9, kpi.cagr);
  const dividend = Math.max(0, kpi.annualDividendYield);
  const reinvestedCagr = ((1 + baseCagr / 100) * (1 + dividend / 100) - 1) * 100;
  return {
    ...kpi,
    cagr: Math.round((reinvestedCagr + Number.EPSILON) * 100) / 100,
  };
}

function getKpiPeriodByWindow(
  items: AssetItem[],
  historyMap: Record<string, PricePoint[]>,
  window: KpiWindow
): { start: string; end: string } | null {
  const minRequiredPoints = KPI_WINDOW_MIN_POINTS[window];
  const validItems = items.filter((item) => (historyMap[item.code]?.length ?? 0) >= minRequiredPoints);
  if (validItems.length === 0) return null;

  const commonDates = new Set(historyMap[validItems[0].code].map((point) => point.date));
  for (let i = 1; i < validItems.length; i += 1) {
    const dates = new Set(historyMap[validItems[i].code].map((point) => point.date));
    for (const date of [...commonDates]) {
      if (!dates.has(date)) commonDates.delete(date);
    }
  }

  const sortedDates = [...commonDates].sort();
  if (sortedDates.length < minRequiredPoints) return null;
  const maxPoints = KPI_WINDOW_MAX_POINTS[window];
  const slicedDates = sortedDates.slice(-Math.min(sortedDates.length, maxPoints));
  if (slicedDates.length < minRequiredPoints) return null;
  return {
    start: slicedDates[0],
    end: slicedDates[slicedDates.length - 1],
  };
}

type WeeklyReturnSeries = {
  dates: string[];
  values: number[];  // 100 = base (1년 전 100% 투자)
};

function computeWeeklyReturnSeries(
  items: AssetItem[],
  historyByCode: Record<string, PricePoint[]>,
  weekInterval = 5
): WeeklyReturnSeries | null {
  const MIN_POINTS = 30;
  const MAX_POINTS = 252;

  const validItems = items.filter(
    (item) => item.weight > 0 && (historyByCode[item.code]?.length ?? 0) >= MIN_POINTS
  );
  if (validItems.length === 0) return null;

  const commonDates = new Set(historyByCode[validItems[0].code].map((p) => p.date));
  for (let i = 1; i < validItems.length; i += 1) {
    const dates = new Set(historyByCode[validItems[i].code].map((p) => p.date));
    for (const d of [...commonDates]) {
      if (!dates.has(d)) commonDates.delete(d);
    }
  }
  const sortedDates = [...commonDates].sort();
  if (sortedDates.length < MIN_POINTS) return null;
  const slicedDates = sortedDates.slice(-Math.min(sortedDates.length, MAX_POINTS));

  const wSum = validItems.reduce((s, it) => s + Math.max(0, it.weight), 0);
  if (wSum <= 0) return null;
  const weights = validItems.map((it) => Math.max(0, it.weight) / wSum);

  const priceMap = validItems.reduce<Record<string, Map<string, number>>>((acc, item) => {
    acc[item.code] = new Map(historyByCode[item.code].map((p) => [p.date, p.close]));
    return acc;
  }, {});

  const baseDate = slicedDates[0];
  const basePrices = validItems.map((item) => priceMap[item.code].get(baseDate) ?? 0);
  if (basePrices.some((p) => p <= 0)) return null;

  const weeklyDates: string[] = [];
  const weeklyValues: number[] = [];

  for (let i = 0; i < slicedDates.length; i += weekInterval) {
    const date = slicedDates[i];
    let idx = 0;
    for (let j = 0; j < validItems.length; j += 1) {
      const close = priceMap[validItems[j].code].get(date) ?? basePrices[j];
      idx += weights[j] * (close / basePrices[j]);
    }
    weeklyDates.push(date);
    weeklyValues.push(idx * 100);
  }

  // 마지막 날짜가 빠져있으면 추가
  const lastDate = slicedDates[slicedDates.length - 1];
  if (weeklyDates[weeklyDates.length - 1] !== lastDate) {
    let idx = 0;
    for (let j = 0; j < validItems.length; j += 1) {
      const close = priceMap[validItems[j].code].get(lastDate) ?? basePrices[j];
      idx += weights[j] * (close / basePrices[j]);
    }
    weeklyDates.push(lastDate);
    weeklyValues.push(idx * 100);
  }

  return { dates: weeklyDates, values: weeklyValues };
}

function calculateCompoundProjection(
  initialPrincipal: number,
  annualContribution: number,
  annualReturnPercent: number,
  years: number
): CompoundProjectionPoint[] {
  const safeInitial = Math.max(0, initialPrincipal);
  const safeAnnual = Math.max(0, annualContribution);
  const safeYears = Math.max(0, Math.floor(years));
  const safeRate = Math.max(0, annualReturnPercent) / 100;

  let totalAsset = safeInitial;
  let principalSum = safeInitial;
  const points: CompoundProjectionPoint[] = [
    {
      year: 0,
      totalAsset,
      principalSum,
      profit: totalAsset - principalSum,
    },
  ];

  for (let year = 1; year <= safeYears; year += 1) {
    totalAsset = totalAsset * (1 + safeRate) + safeAnnual;
    principalSum += safeAnnual;
    points.push({
      year,
      totalAsset,
      principalSum,
      profit: totalAsset - principalSum,
    });
  }

  return points;
}

function toChartPoints(
  values: number[],
  width: number,
  height: number,
  padX: number,
  padY: number,
  min: number,
  max: number
): string {
  const safeValues = values.length > 0 ? values : [0];
  const chartWidth = width - padX * 2;
  const chartHeight = height - padY * 2;
  const range = Math.max(1, max - min);
  return safeValues
    .map((value, index) => {
      const x =
        safeValues.length === 1
          ? padX
          : padX + (chartWidth * index) / (safeValues.length - 1);
      const y = padY + ((max - value) / range) * chartHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function formatCompactKrw(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}억`;
  if (abs >= 10_000) return `${Math.round(value / 10_000).toLocaleString("ko-KR")}만`;
  return Math.round(value).toLocaleString("ko-KR");
}

function getCompoundEvaluationText(
  annualReturnPercent: number,
  years: number,
  principalSum: number,
  totalAsset: number,
  totalReturnPercent: number
): string {
  if (years <= 0) return "투자 기간을 1년 이상으로 설정하면 복리 추세 평가를 제공할 수 있습니다.";
  if (principalSum <= 0) return "원금이 0원이므로 원금 또는 매년 추가원금을 입력해 시나리오를 확인해 보세요.";

  const riskBand =
    annualReturnPercent >= 15
      ? "고수익·고변동"
      : annualReturnPercent >= 10
        ? "공격형"
        : annualReturnPercent >= 6
          ? "중립형"
          : "안정형";

  const multiple = totalAsset / principalSum;
  if (totalReturnPercent < 10) {
    return `${riskBand} 목표로 설정되었고, ${years}년 누적 수익률은 ${formatPercent(
      totalReturnPercent
    )}입니다. 원금 보전 중심 관점에서 무난한 시나리오입니다.`;
  }
  if (totalReturnPercent < 50) {
    return `${riskBand} 목표(${formatPercent(
      annualReturnPercent
    )}) 기준으로 ${years}년 뒤 원금 대비 자산 배율은 약 ${multiple.toFixed(
      2
    )}배입니다. 꾸준한 추가원금이 성과에 의미 있게 기여하는 구간입니다.`;
  }
  return `${riskBand} 목표를 유지하면 ${years}년 누적 수익률 ${formatPercent(
    totalReturnPercent
  )}, 원금 대비 약 ${multiple.toFixed(
    2
  )}배 자산 시나리오입니다. 수익 기대는 높지만 변동성 관리가 중요합니다.`;
}

function App() {
  const [selection, setSelection] = useState<SelectionState>({
    principal: 0,
    strategy: "A",
    mode: "중립형",
    kpiWindow: "1Y",
  });
  const [principalFocused, setPrincipalFocused] = useState(false);
  const [compoundInitialPrincipal, setCompoundInitialPrincipal] = useState(0);
  const [compoundAnnualContribution, setCompoundAnnualContribution] = useState(0);
  const [compoundTargetReturn, setCompoundTargetReturn] = useState(7);
  const [compoundYears, setCompoundYears] = useState(10);
  const [compoundInitialFocused, setCompoundInitialFocused] = useState(false);
  const [compoundAnnualFocused, setCompoundAnnualFocused] = useState(false);
  const [appliedSelection, setAppliedSelection] = useState<AppliedSelection | null>(null);
  const [resultPortfolio, setResultPortfolio] = useState<Portfolio | null>(null);
  const [historyByCode, setHistoryByCode] = useState<Record<string, PricePoint[]>>({});
  const [latestQuoteByCode, setLatestQuoteByCode] = useState<
    Record<string, { price: number; source: string; fetchedAt: string }>
  >({});
  const [actualDividendYieldByCode, setActualDividendYieldByCode] = useState<Record<string, number>>({});
  const [strategyCompareMode, setStrategyCompareMode] = useState<StrategyCompareMode | null>(null);
  const [strategyCompareLoading, setStrategyCompareLoading] = useState(false);
  const [strategyCompareRows, setStrategyCompareRows] = useState<StrategyComparisonRow[]>([]);
  const [strategyCompareError, setStrategyCompareError] = useState<string | null>(null);
  const [, setStrategyComparePrincipal] = useState<number | null>(null);
  const [, setStrategyCompareUpdatedAt] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>(() => createInitialRefreshState());
  const [refreshMessage, setRefreshMessage] = useState("선택 후 결과 보기를 누르세요.");
  const refreshIdRef = useRef(0);
  const startupWarmupStartedRef = useRef(false);

  // B형 1년 수익률 그래프
  type BModeChartData = Record<PortfolioMode, WeeklyReturnSeries>;
  const [bModeChartData, setBModeChartData] = useState<BModeChartData | null>(null);
  const [bModeChartLoading, setBModeChartLoading] = useState(false);
  const [bModeChartError, setBModeChartError] = useState<string | null>(null);

  // 최적 포트폴리오 탐색
  const [optimalResults, setOptimalResults] = useState<OptimalResult[] | null>(null);
  const [optimalLoading, setOptimalLoading] = useState(false);
  const [optimalError, setOptimalError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  const requiresMode = selection.strategy === "A" || selection.strategy === "B";
  const canShowResult = selection.principal > 0 && (!requiresMode || Boolean(selection.mode));

  const refreshStageText: Record<RefreshStage, string> = {
    idle: "대기",
    price: "최신 시세 조회 중",
    kpi: "KPI 데이터 조회 중",
    done: "완료",
    error: "오류",
  };

  useEffect(() => {
    if (startupWarmupStartedRef.current) return;
    startupWarmupStartedRef.current = true;

    const codes = uniqueCodesFromItems(initialPortfolios.flatMap((portfolio) => portfolio.items));
    let cancelled = false;

    void (async () => {
      try {
        // 1) 최신 시세 조회
        const cachedQuotes = getStoredLatestQuotesByCodes(codes);
        const priceCodesToFetch = codes.filter(
          (code) => !isStoredLatestQuoteFresh(cachedQuotes[code], STARTUP_PRICE_MAX_AGE_MS)
        );
        if (priceCodesToFetch.length > 0) {
          const { prices, sourceByCode } = await fetchPricesByCodes(priceCodesToFetch);
          if (cancelled) return;
          upsertStoredLatestQuotes(prices, sourceByCode);
        }

        // 2) 1년 히스토리 조회 (KPI 계산용)
        const cachedHistories = getStoredHistoriesByCodes(codes);
        const historyCodesToFetch = codes.filter(
          (code) => !isStoredHistoryFresh(cachedHistories[code], HISTORY_STALE_DAYS)
        );
        if (historyCodesToFetch.length > 0 && !cancelled) {
          const { historyByCode } = await fetchOneYearHistoriesByCodes(
            historyCodesToFetch,
            undefined,
            {
              existingHistoryByCode: cachedHistories,
              preferIncremental: true,
              recentStaleDays: HISTORY_STALE_DAYS,
            }
          );
          if (cancelled) return;
          upsertStoredHistories(historyByCode);
        }

        // 3) 배당수익률 조회
        const cachedDividendYields = getStoredDividendYieldsByCodes(codes);
        const dividendCodesToFetch = codes.filter(
          (code) => !isStoredDividendYieldFresh(cachedDividendYields[code], DIVIDEND_STALE_DAYS)
        );
        if (dividendCodesToFetch.length > 0 && !cancelled) {
          const { dividendYieldByCode, sourceByCode } = await fetchDividendYieldsByCodes(dividendCodesToFetch);
          if (cancelled) return;
          upsertStoredDividendYields(dividendYieldByCode, sourceByCode);
        }
      } catch {
        // background warm-up failure is silently ignored
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const resultRows = useMemo(() => {
    if (!resultPortfolio) return [];
    return resultPortfolio.items.map((item) => {
      const quantity = Math.max(
        0,
        Math.round(calcShareCount(resultPortfolio.principal, item.weight, item.price, { precision: 4 }))
      );
      const amount = calcCheckAmount(item.price, quantity);
      const priceFetchedDate = formatYmdFromIso(latestQuoteByCode[item.code]?.fetchedAt);
      const actualDividendYield = actualDividendYieldByCode[item.code];
      const appliedDividendYield =
        Number.isFinite(actualDividendYield) && (actualDividendYield ?? 0) >= 0
          ? (actualDividendYield as number)
          : item.dividendYield;
      const periodReturnByWindow: Record<KpiWindow, number | null> = {
        "1Y": calculateWindowPeriodReturn(historyByCode[item.code], "1Y"),
        "6M": calculateWindowPeriodReturn(historyByCode[item.code], "6M"),
        "3M": calculateWindowPeriodReturn(historyByCode[item.code], "3M"),
        "1M": calculateWindowPeriodReturn(historyByCode[item.code], "1M"),
      };
      return { item, quantity, amount, priceFetchedDate, periodReturnByWindow, appliedDividendYield };
    });
  }, [actualDividendYieldByCode, historyByCode, latestQuoteByCode, resultPortfolio]);

  const totalCheckAmount = useMemo(() => {
    return resultRows.reduce((sum, row) => sum + row.amount, 0);
  }, [resultRows]);
  const investedPrincipal = appliedSelection?.principal ?? resultPortfolio?.principal ?? 0;
  const roundingGap = investedPrincipal - totalCheckAmount;
  const roundingGapLabel = roundingGap > 0 ? "미배분 잔액" : roundingGap < 0 ? "초과 배분" : "차이 없음";

  const weightSum = useMemo(() => {
    return resultPortfolio ? calcWeightSum(resultPortfolio.items) : 0;
  }, [resultPortfolio]);
  const activeKpiWindow = appliedSelection?.kpiWindow ?? selection.kpiWindow;
  const activeKpiLabel = KPI_WINDOW_LABELS[activeKpiWindow];
  const averageKpi = withDividendReinvestedCagr(resultPortfolio?.kpi ?? null);
  const selectedWindowKpi = useMemo(() => {
    if (!resultPortfolio) return null;
    return calculatePortfolioKpiFromHistoryWindow(resultPortfolio.items, historyByCode, activeKpiWindow);
  }, [activeKpiWindow, historyByCode, resultPortfolio]);
  const annualDividendBySelectedWindow =
    selectedWindowKpi != null
      ? investedPrincipal * (Math.max(0, selectedWindowKpi.annualDividendYield) / 100)
      : null;
  const monthlyDividendBySelectedWindow =
    annualDividendBySelectedWindow != null ? annualDividendBySelectedWindow / 12 : null;
  const selectedKpiPeriod = useMemo(() => {
    if (!resultPortfolio) return null;
    return getKpiPeriodByWindow(resultPortfolio.items, historyByCode, activeKpiWindow);
  }, [activeKpiWindow, historyByCode, resultPortfolio]);
  const compoundProjection = useMemo(
    () =>
      calculateCompoundProjection(
        compoundInitialPrincipal,
        compoundAnnualContribution,
        compoundTargetReturn,
        compoundYears
      ),
    [compoundAnnualContribution, compoundInitialPrincipal, compoundTargetReturn, compoundYears]
  );
  const compoundFinal = compoundProjection[compoundProjection.length - 1] ?? {
    year: 0,
    totalAsset: 0,
    principalSum: 0,
    profit: 0,
  };
  const compoundTotalReturnPercent =
    compoundFinal.principalSum > 0 ? (compoundFinal.profit / compoundFinal.principalSum) * 100 : 0;
  const compoundChart = useMemo(() => {
    const width = 360;
    const height = 170;
    const padX = 20;
    const padY = 16;
    const assetSeries = compoundProjection.map((point) => point.totalAsset);
    const principalSeries = compoundProjection.map((point) => point.principalSum);
    const maxValue = Math.max(1, ...assetSeries, ...principalSeries);
    const minValue = 0;
    const assetLine = toChartPoints(assetSeries, width, height, padX, padY, minValue, maxValue);
    const principalLine = toChartPoints(principalSeries, width, height, padX, padY, minValue, maxValue);
    const chartBottom = height - padY;
    const area = `${padX},${chartBottom} ${assetLine} ${width - padX},${chartBottom}`;
    const midIndex = Math.floor((compoundProjection.length - 1) / 2);

    return {
      width,
      height,
      assetLine,
      principalLine,
      area,
      labels: [
        { key: "start", x: padX, label: "0년" },
        { key: "mid", x: padX + ((width - padX * 2) * (compoundProjection.length > 1 ? midIndex / (compoundProjection.length - 1) : 0)), label: `${midIndex}년` },
        { key: "end", x: width - padX, label: `${Math.max(0, compoundYears)}년` },
      ],
      yTop: formatCompactKrw(maxValue),
      yBottom: formatCompactKrw(0),
    };
  }, [compoundProjection, compoundYears]);
  const compoundEvaluationText = useMemo(
    () =>
      getCompoundEvaluationText(
        compoundTargetReturn,
        compoundYears,
        compoundFinal.principalSum,
        compoundFinal.totalAsset,
        compoundTotalReturnPercent
      ),
    [compoundFinal.principalSum, compoundFinal.totalAsset, compoundTargetReturn, compoundTotalReturnPercent, compoundYears]
  );

  const totalCodes = Math.max(1, refreshState.totalCodes);
  const totalSteps = totalCodes * 2;
  const doneSteps =
    refreshState.stage === "done"
      ? totalSteps
      : Math.min(totalSteps, refreshState.priceDone + refreshState.kpiDone);
  const progressPercent = Math.round((doneSteps / totalSteps) * 100);
  const isRefreshing = refreshState.stage === "price" || refreshState.stage === "kpi";
  // refreshActionLabel and strategyCompareTitle removed (unused after mobile redesign)

  const refreshForPortfolio = async (portfolio: Portfolio) => {
    const refreshId = refreshIdRef.current + 1;
    refreshIdRef.current = refreshId;

    const codeNameMap = portfolio.items.reduce<Record<string, string>>((acc, item) => {
      acc[item.code] = item.name;
      return acc;
    }, {});
    const codes = uniqueCodesFromItems(portfolio.items);
    const cachedQuotes = getStoredLatestQuotesByCodes(codes);
    const cachedDividendYields = getStoredDividendYieldsByCodes(codes);
    const cachedDividendYieldByCode = Object.entries(cachedDividendYields).reduce<Record<string, number>>(
      (acc, [code, entry]) => {
        acc[code] = entry.dividendYield;
        return acc;
      },
      {}
    );
    const cachedPricesByCode = Object.entries(cachedQuotes).reduce<Record<string, number>>((acc, [code, quote]) => {
      acc[code] = quote.price;
      return acc;
    }, {});
    const freshPriceCodes = codes.filter((code) =>
      isStoredLatestQuoteFresh(cachedQuotes[code], RUNTIME_PRICE_MAX_AGE_MS)
    );
    const priceCodesToFetch = codes.filter((code) => !freshPriceCodes.includes(code));
    setLatestQuoteByCode(cachedQuotes);
    setActualDividendYieldByCode(cachedDividendYieldByCode);

    if (Object.keys(cachedPricesByCode).length > 0) {
      setResultPortfolio((prev) => (prev ? applyPriceMapToPortfolio(prev, cachedPricesByCode) : prev));
    }
    if (Object.keys(cachedDividendYieldByCode).length > 0) {
      setResultPortfolio((prev) => (prev ? applyDividendYieldMapToPortfolio(prev, cachedDividendYieldByCode) : prev));
    }

    setRefreshState({
      ...createInitialRefreshState(),
      stage: "price",
      totalCodes: codes.length,
      priceDone: freshPriceCodes.length,
      priceSuccess: freshPriceCodes.length,
      priceFailed: 0,
      priceAppliedDate: getAppliedPriceDateFromQuotes(cachedQuotes),
    });
    setRefreshMessage(
      priceCodesToFetch.length === 0
        ? "저장된 최신 시세를 사용합니다. KPI 데이터를 확인합니다."
        : `저장소 시세를 먼저 적용한 뒤, 최신 누락분 ${priceCodesToFetch.length}개를 조회합니다.`
    );

    try {
      if (priceCodesToFetch.length > 0) {
        const priceDoneBase = freshPriceCodes.length;
        const priceSuccessBase = freshPriceCodes.length;

        const { prices, sourceByCode } = await fetchPricesByCodes(priceCodesToFetch, (progress) => {
          if (refreshIdRef.current !== refreshId) return;
          const name = codeNameMap[progress.code] ?? progress.code;
          const done = priceDoneBase + progress.done;
          const success = priceSuccessBase + progress.successCount;
          const failed = Math.max(0, done - success);
          setRefreshState((prev) => ({
            ...prev,
            stage: "price",
            totalCodes: codes.length,
            priceDone: done,
            priceSuccess: success,
            priceFailed: failed,
            currentName: name,
          }));
          setRefreshMessage(`최신 시세 ${done}/${codes.length}: ${name}`);

          if (progress.result) {
            const latest = progress.result;
            setResultPortfolio((prev) => {
              if (!prev) return prev;
              return applyPriceMapToPortfolio(prev, { [progress.code]: latest.price });
            });
          }
        });

        if (refreshIdRef.current !== refreshId) return;
        upsertStoredLatestQuotes(prices, sourceByCode);
      }

      if (refreshIdRef.current !== refreshId) return;

      const latestQuotes = getStoredLatestQuotesByCodes(codes);
      setLatestQuoteByCode(latestQuotes);
      const latestPricesByCode = Object.entries(latestQuotes).reduce<Record<string, number>>((acc, [code, quote]) => {
        acc[code] = quote.price;
        return acc;
      }, {});
      if (Object.keys(latestPricesByCode).length > 0) {
        setResultPortfolio((prev) => (prev ? applyPriceMapToPortfolio(prev, latestPricesByCode) : prev));
      }

      const priceSuccess = Object.keys(latestPricesByCode).length;
      const priceFailed = Math.max(0, codes.length - priceSuccess);
      const priceAppliedDate = getAppliedPriceDateFromQuotes(latestQuotes);

      const cachedHistories = getStoredHistoriesByCodes(codes);
      if (Object.keys(cachedHistories).length > 0) {
        setHistoryByCode(cachedHistories);
      }
      const freshHistoryCodes = codes.filter((code) =>
        isStoredHistoryFresh(cachedHistories[code], HISTORY_STALE_DAYS)
      );
      const historyCodesToFetch = codes.filter((code) => !freshHistoryCodes.includes(code));

      setRefreshState((prev) => ({
        ...prev,
        stage: "kpi",
        priceDone: codes.length,
        priceSuccess,
        priceFailed,
        priceAppliedDate,
        kpiDone: freshHistoryCodes.length,
        kpiSuccess: freshHistoryCodes.length,
        kpiFailed: 0,
        currentName: null,
      }));
      setRefreshMessage(
        historyCodesToFetch.length === 0
          ? "저장된 KPI 히스토리가 최신입니다."
          : `최신 일자부터 KPI 히스토리 누락분 ${historyCodesToFetch.length}개를 조회합니다.`
      );

      if (historyCodesToFetch.length > 0) {
        const kpiDoneBase = freshHistoryCodes.length;
        const kpiSuccessBase = freshHistoryCodes.length;

        const { historyByCode } = await fetchOneYearHistoriesByCodes(
          historyCodesToFetch,
          (progress) => {
            if (refreshIdRef.current !== refreshId) return;
            const name = codeNameMap[progress.code] ?? progress.code;
            const done = kpiDoneBase + progress.done;
            const success = kpiSuccessBase + progress.successCount;
            const failed = Math.max(0, done - success);
            setRefreshState((prev) => ({
              ...prev,
              stage: "kpi",
              totalCodes: codes.length,
              kpiDone: done,
              kpiSuccess: success,
              kpiFailed: failed,
              currentName: name,
            }));
            setRefreshMessage(`KPI 데이터 ${done}/${codes.length}: ${name}`);
          },
          {
            existingHistoryByCode: cachedHistories,
            preferIncremental: true,
            recentStaleDays: HISTORY_STALE_DAYS,
          }
        );

        if (refreshIdRef.current !== refreshId) return;
        upsertStoredHistories(historyByCode);
      }

      if (refreshIdRef.current !== refreshId) return;
      const finalHistoryByCode = getStoredHistoriesByCodes(codes);
      setHistoryByCode(finalHistoryByCode);
      const freshDividendCodes = codes.filter((code) =>
        isStoredDividendYieldFresh(cachedDividendYields[code], DIVIDEND_STALE_DAYS)
      );
      const dividendCodesToFetch = codes.filter((code) => !freshDividendCodes.includes(code));
      if (dividendCodesToFetch.length > 0) {
        setRefreshMessage(`실지급 배당률 누락분 ${dividendCodesToFetch.length}개를 조회합니다.`);
        const { dividendYieldByCode, sourceByCode } = await fetchDividendYieldsByCodes(dividendCodesToFetch);
        if (refreshIdRef.current !== refreshId) return;
        upsertStoredDividendYields(dividendYieldByCode, sourceByCode);
      }

      if (refreshIdRef.current !== refreshId) return;
      const finalDividendEntries = getStoredDividendYieldsByCodes(codes);
      const finalDividendYieldByCode = Object.entries(finalDividendEntries).reduce<Record<string, number>>(
        (acc, [code, entry]) => {
          acc[code] = entry.dividendYield;
          return acc;
        },
        {}
      );
      setActualDividendYieldByCode(finalDividendYieldByCode);
      if (Object.keys(finalDividendYieldByCode).length > 0) {
        setResultPortfolio((prev) => (prev ? applyDividendYieldMapToPortfolio(prev, finalDividendYieldByCode) : prev));
      }

      const now = new Date();
      const timeText = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(
        now.getDate()
      ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`;
      const kpiSuccess = Object.keys(finalHistoryByCode).length;

      setRefreshState((prev) => ({
        ...prev,
        stage: "done",
        currentName: null,
        priceAppliedDate,
        kpiSuccess,
        kpiFailed: Math.max(0, codes.length - kpiSuccess),
        lastUpdatedAt: timeText,
      }));
      setRefreshMessage(
        `최종 갱신 ${timeText} · 시세 ${priceSuccess}/${codes.length} · KPI ${kpiSuccess}/${codes.length}`
      );
    } catch {
      if (refreshIdRef.current !== refreshId) return;
      setRefreshState((prev) => ({
        ...prev,
        stage: "error",
        currentName: null,
      }));
      setRefreshMessage("시세/KPI 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    }
  };

  const handleShowResult = () => {
    if (!canShowResult) return;
    const configured = createConfiguredPortfolio(selection);
    const codes = uniqueCodesFromItems(configured.items);
    const cachedQuotes = getStoredLatestQuotesByCodes(codes);
    const cachedDividendYields = getStoredDividendYieldsByCodes(codes);
    const cachedDividendYieldByCode = Object.entries(cachedDividendYields).reduce<Record<string, number>>(
      (acc, [code, item]) => {
        acc[code] = item.dividendYield;
        return acc;
      },
      {}
    );
    const cachedPricesByCode = Object.entries(cachedQuotes).reduce<Record<string, number>>((acc, [code, quote]) => {
      acc[code] = quote.price;
      return acc;
    }, {});
    const hydratedWithPrice = applyPriceMapToPortfolio(configured, cachedPricesByCode);
    const hydrated = applyDividendYieldMapToPortfolio(hydratedWithPrice, cachedDividendYieldByCode);
    const cachedHistoryByCode = getStoredHistoriesByCodes(codes);
    setLatestQuoteByCode(cachedQuotes);
    setActualDividendYieldByCode(cachedDividendYieldByCode);

    setHistoryByCode(cachedHistoryByCode);
    setStrategyCompareMode(null);
    setStrategyCompareRows([]);
    setStrategyCompareError(null);
    setStrategyComparePrincipal(null);
    setStrategyCompareUpdatedAt(null);
    setAppliedSelection({
      principal: selection.principal,
      strategy: selection.strategy,
      mode: selection.mode,
      kpiWindow: selection.kpiWindow,
    });
    setResultPortfolio(hydrated);
    void refreshForPortfolio(hydrated);
  };

  const handleRefreshLatest = () => {
    if (!resultPortfolio) return;
    void refreshForPortfolio(resultPortfolio);
  };

  const handleCompareOneYearKpi = async (mode: StrategyCompareMode) => {
    if (strategyCompareLoading) return;

    if (strategyCompareMode === mode) {
      setStrategyCompareMode(null);
      return;
    }

    const principal = appliedSelection?.principal ?? resultPortfolio?.principal ?? selection.principal;
    const appliedModeForAB: PortfolioMode =
      appliedSelection?.mode ?? selection.mode ?? "중립형";

    const compareRowsInput:
      | Array<{
          key: string;
          label: string;
          strategy: string;
          mode: PortfolioMode | null;
          portfolio: Portfolio;
        }>
      = mode === "A_GROWTH_SP500"
        ? [
            {
              key: "A-성장형",
              label: "A (성장형)",
              strategy: "A",
              mode: "성장형",
              portfolio: createConfiguredPortfolio({
                principal,
                strategy: "A",
                mode: "성장형",
                kpiWindow: activeKpiWindow,
              }),
            },
            {
              key: "SP500-100",
              label: SP500_BENCHMARK_DISPLAY,
              strategy: "BM",
              mode: null,
              portfolio: createSp500OnlyPortfolio(principal),
            },
          ]
        : (() => {
            const compareSelections: SelectionState[] =
              mode === "ABCDE"
                ? STRATEGY_LIST.map((strategy) => ({
                    principal,
                    strategy,
                    mode: strategy === "A" || strategy === "B" ? appliedModeForAB : null,
                    kpiWindow: activeKpiWindow,
                  }))
                : (["안정형", "중립형", "성장형"] as PortfolioMode[]).map((m) => ({
                    principal,
                    strategy: mode === "A_MODES" ? "A" : "B",
                    mode: m,
                    kpiWindow: activeKpiWindow,
                  }));

            return compareSelections.map((item, index) => {
              const label =
                mode === "ABCDE"
                  ? item.mode && (item.strategy === "A" || item.strategy === "B")
                    ? `${item.strategy} (${item.mode})`
                    : item.strategy
                  : (item.mode ?? "-");

              return {
                key: `${item.strategy}-${item.mode ?? "none"}-${index}`,
                label,
                strategy: item.strategy,
                mode: item.mode,
                portfolio: createConfiguredPortfolio(item),
              };
            });
          })();

    const allCodes = uniqueCodesFromItems(compareRowsInput.flatMap((row) => row.portfolio.items));

    setStrategyCompareMode(mode);
    setStrategyCompareLoading(true);
    setStrategyCompareError(null);

    try {
      const cachedDividendYields = getStoredDividendYieldsByCodes(allCodes);
      const staleDividendCodes = allCodes.filter(
        (code) => !isStoredDividendYieldFresh(cachedDividendYields[code], DIVIDEND_STALE_DAYS)
      );
      if (staleDividendCodes.length > 0) {
        const { dividendYieldByCode, sourceByCode } = await fetchDividendYieldsByCodes(staleDividendCodes);
        upsertStoredDividendYields(dividendYieldByCode, sourceByCode);
      }
      const finalDividendEntries = getStoredDividendYieldsByCodes(allCodes);
      const finalDividendYieldByCode = Object.entries(finalDividendEntries).reduce<Record<string, number>>(
        (acc, [code, entry]) => {
          acc[code] = entry.dividendYield;
          return acc;
        },
        {}
      );
      setActualDividendYieldByCode((prev) => ({ ...prev, ...finalDividendYieldByCode }));
      const compareRowsWithDividend = compareRowsInput.map((rowInput) => ({
        ...rowInput,
        portfolio: applyDividendYieldMapToPortfolio(rowInput.portfolio, finalDividendYieldByCode),
      }));

      const cachedHistories = getStoredHistoriesByCodes(allCodes);
      const staleCodes = allCodes.filter(
        (code) => !isStoredHistoryFresh(cachedHistories[code], HISTORY_STALE_DAYS)
      );

      if (staleCodes.length > 0) {
        const { historyByCode } = await fetchOneYearHistoriesByCodes(
          staleCodes,
          undefined,
          {
            existingHistoryByCode: cachedHistories,
            preferIncremental: true,
            recentStaleDays: HISTORY_STALE_DAYS,
          }
        );
        upsertStoredHistories(historyByCode);
      }

      const finalHistories = getStoredHistoriesByCodes(allCodes);
      const rows: StrategyComparisonRow[] = compareRowsWithDividend.map((rowInput) => {
        const kpi = calculatePortfolioKpiFromHistoryWindow(
          rowInput.portfolio.items,
          finalHistories,
          activeKpiWindow
        );
        const monthlyDividend =
          kpi != null ? (principal * Math.max(0, kpi.annualDividendYield)) / 100 / 12 : null;
        const period = getKpiPeriodByWindow(rowInput.portfolio.items, finalHistories, activeKpiWindow);

        return {
          id: rowInput.key,
          label: rowInput.label,
          strategy: rowInput.strategy,
          mode: rowInput.mode,
          kpi,
          monthlyDividend,
          periodStart: period?.start ?? null,
          periodEnd: period?.end ?? null,
        };
      });

      setStrategyCompareRows(rows);
      setStrategyComparePrincipal(principal);
      setStrategyCompareUpdatedAt(formatYmdFromDate(new Date()));
    } catch {
      setStrategyCompareError("전략 비교 데이터 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setStrategyCompareLoading(false);
    }
  };

  const handleLoadBModeChart = async () => {
    if (bModeChartLoading) return;
    if (bModeChartData) {
      setBModeChartData(null);
      return;
    }

    setBModeChartLoading(true);
    setBModeChartError(null);

    try {
      const modes: PortfolioMode[] = ["안정형", "중립형", "성장형"];
      const portfolios = modes.map((m) =>
        createConfiguredPortfolio({ principal: 100_000_000, strategy: "B", mode: m, kpiWindow: "1Y" })
      );

      const allCodes = uniqueCodesFromItems(portfolios.flatMap((p) => p.items));

      // 배당 수익률 갱신
      const cachedDY = getStoredDividendYieldsByCodes(allCodes);
      const staleDYCodes = allCodes.filter((c) => !isStoredDividendYieldFresh(cachedDY[c], DIVIDEND_STALE_DAYS));
      if (staleDYCodes.length > 0) {
        const { dividendYieldByCode: dyMap, sourceByCode } = await fetchDividendYieldsByCodes(staleDYCodes);
        upsertStoredDividendYields(dyMap, sourceByCode);
      }

      // 히스토리 갱신
      const cachedHistories = getStoredHistoriesByCodes(allCodes);
      const staleCodes = allCodes.filter((c) => !isStoredHistoryFresh(cachedHistories[c], HISTORY_STALE_DAYS));
      if (staleCodes.length > 0) {
        const { historyByCode: hMap } = await fetchOneYearHistoriesByCodes(staleCodes, undefined, {
          existingHistoryByCode: cachedHistories,
          preferIncremental: true,
          recentStaleDays: HISTORY_STALE_DAYS,
        });
        upsertStoredHistories(hMap);
      }

      const finalHistories = getStoredHistoriesByCodes(allCodes);

      const result = {} as Record<PortfolioMode, WeeklyReturnSeries>;
      for (let i = 0; i < modes.length; i += 1) {
        const series = computeWeeklyReturnSeries(portfolios[i].items, finalHistories);
        if (!series) {
          setBModeChartError("B형 히스토리 데이터가 부족합니다. 먼저 '결과 보기'를 실행해 주세요.");
          setBModeChartLoading(false);
          return;
        }
        result[modes[i]] = series;
      }

      setBModeChartData(result);
    } catch {
      setBModeChartError("B형 수익률 데이터 조회 중 오류가 발생했습니다.");
    } finally {
      setBModeChartLoading(false);
    }
  };

  const handleFindOptimal = async () => {
    if (optimalLoading) return;
    if (optimalResults) {
      setOptimalResults(null);
      return;
    }

    setOptimalLoading(true);
    setOptimalError(null);

    try {
      const allCodes = OPTIMIZER_ALL_CODES;

      // 배당 수익률 갱신
      const cachedDY = getStoredDividendYieldsByCodes(allCodes);
      const staleDYCodes = allCodes.filter((c) => !isStoredDividendYieldFresh(cachedDY[c], DIVIDEND_STALE_DAYS));
      if (staleDYCodes.length > 0) {
        const { dividendYieldByCode: dyMap, sourceByCode } = await fetchDividendYieldsByCodes(staleDYCodes);
        upsertStoredDividendYields(dyMap, sourceByCode);
      }

      // 히스토리 갱신
      const cachedH = getStoredHistoriesByCodes(allCodes);
      const staleHCodes = allCodes.filter((c) => !isStoredHistoryFresh(cachedH[c], HISTORY_STALE_DAYS));
      if (staleHCodes.length > 0) {
        const { historyByCode: hMap } = await fetchOneYearHistoriesByCodes(staleHCodes, undefined, {
          existingHistoryByCode: cachedH,
          preferIncremental: true,
          recentStaleDays: HISTORY_STALE_DAYS,
        });
        upsertStoredHistories(hMap);
      }

      const finalH = getStoredHistoriesByCodes(allCodes);
      const finalDYEntries = getStoredDividendYieldsByCodes(allCodes);
      const finalDY = Object.entries(finalDYEntries).reduce<Record<string, number>>(
        (acc, [code, entry]) => { acc[code] = entry.dividendYield; return acc; },
        {},
      );

      // 최적화 실행 (동기 — ~1-2초 소요)
      const results = findOptimalPortfolios(finalH, finalDY, 3);
      if (results.length === 0) {
        setOptimalError("히스토리 데이터가 부족합니다. 먼저 '결과 보기'를 실행해 주세요.");
      } else {
        setOptimalResults(results);
      }
    } catch {
      setOptimalError("최적 포트폴리오 탐색 중 오류가 발생했습니다.");
    } finally {
      setOptimalLoading(false);
    }
  };

  const bModeChart = useMemo(() => {
    if (!bModeChartData) return null;

    const modes: PortfolioMode[] = ["안정형", "중립형", "성장형"];
    const colors: Record<PortfolioMode, string> = {
      안정형: "#3B82F6",
      중립형: "#F59E0B",
      성장형: "#F43F5E",
    };

    const allValues = modes.flatMap((m) => bModeChartData[m].values);
    const minV = Math.min(...allValues);
    const maxV = Math.max(...allValues);
    const pad = (maxV - minV) * 0.05 || 1;
    const chartMin = minV - pad;
    const chartMax = maxV + pad;

    const width = 360;
    const height = 180;
    const padX = 24;
    const padY = 16;

    const lines = modes.map((m) => ({
      mode: m,
      color: colors[m],
      points: toChartPoints(bModeChartData[m].values, width, height, padX, padY, chartMin, chartMax),
      lastValue: bModeChartData[m].values[bModeChartData[m].values.length - 1],
    }));

    // 100% 기준선 y좌표
    const chartHeight = height - padY * 2;
    const range = Math.max(1, chartMax - chartMin);
    const baselineY = padY + ((chartMax - 100) / range) * chartHeight;

    // 기간 라벨
    const dates = bModeChartData["안정형"].dates;
    const startLabel = formatYmdFromDashDate(dates[0]);
    const endLabel = formatYmdFromDashDate(dates[dates.length - 1]);

    return { width, height, padX, padY, lines, baselineY, startLabel, endLabel, chartMin, chartMax };
  }, [bModeChartData]);

  return (
    <div className="min-h-dvh overflow-x-hidden px-2.5 pb-6 pt-3">
      <div className="mx-auto max-w-[460px] space-y-2.5">

        {/* ── Header (compact) ── */}
        <header className="app-header px-4 py-4">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-[15px] font-black tracking-tight text-white">절세계좌 자산배분 투자</h1>
              <p className="mt-1 text-[11px] leading-relaxed text-white/70">
                투자금·전략(A~E) 선택 → 최신 시세 반영 · KPI · 월배당 · 검산
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowManual(true)}
              className="flex-shrink-0 rounded-lg bg-white/20 px-2.5 py-1.5 text-[11px] font-bold text-white backdrop-blur-sm transition-all hover:bg-white/30 active:scale-95"
            >
              사용설명서
            </button>
          </div>
        </header>

        {/* ── 사용설명서 모달 ── */}
        {showManual && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowManual(false); }}
          >
            <div className="relative my-6 w-full max-w-[460px] rounded-2xl bg-white shadow-2xl">
              {/* 모달 헤더 */}
              <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-2xl border-b border-slate-100 bg-white px-5 py-4">
                <h2 className="text-[15px] font-black text-slate-800">사용설명서</h2>
                <button
                  type="button"
                  onClick={() => setShowManual(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-[16px] text-slate-400 transition hover:bg-slate-200 hover:text-slate-600"
                >
                  ✕
                </button>
              </div>

              {/* 모달 본문 */}
              <div className="space-y-5 px-5 py-5 text-[12px] leading-[1.8] text-slate-600">

                {/* 0. 이 앱은 무엇인가요? */}
                <section>
                  <h3 className="mb-1.5 text-[13px] font-extrabold text-indigo-600">이 앱은 무엇인가요?</h3>
                  <p>
                    <b>절세계좌 자산배분 투자</b>는 연금저축, IRP 같은 절세 계좌에서
                    여러 ETF에 돈을 나눠 투자하는 것을 도와주는 앱이에요.
                  </p>
                  <p className="mt-1">
                    쉽게 말해, <b>"달걀을 한 바구니에 담지 말라"</b>는 투자 원칙을 실천하도록
                    도와주는 계산기예요. 주식, 금, 채권, 현금 등 여러 자산에 골고루 나누면
                    하나가 떨어져도 전체 손해가 줄어들어요.
                  </p>
                </section>

                {/* 1. 용어 설명 */}
                <section>
                  <h3 className="mb-1.5 text-[13px] font-extrabold text-indigo-600">알아두면 좋은 용어</h3>
                  <div className="space-y-2.5">
                    <div className="rounded-xl bg-emerald-50 p-3">
                      <p className="font-bold text-emerald-700">CAGR (연평균 복리 수익률)</p>
                      <p className="mt-0.5 text-[11px] text-emerald-600">
                        "1년에 평균 몇 % 벌었을까?"를 알려주는 숫자예요.
                        예를 들어 CAGR 8%이면, 100만원이 1년 뒤 약 108만원이 된다는 뜻이에요.
                        숫자가 클수록 수익이 좋은 거예요!
                      </p>
                    </div>
                    <div className="rounded-xl bg-rose-50 p-3">
                      <p className="font-bold text-rose-700">MDD (최대 낙폭)</p>
                      <p className="mt-0.5 text-[11px] text-rose-600">
                        "가장 많이 떨어진 적이 있을 때, 얼마나 빠졌나?"를 보여줘요.
                        예를 들어 MDD 15%이면, 최고점에서 15% 떨어진 적이 있다는 뜻이에요.
                        숫자가 작을수록 안정적인 거예요. 롤러코스터를 생각하면 돼요 — MDD가 작으면 조용한 기차, 크면 무서운 롤러코스터!
                      </p>
                    </div>
                    <div className="rounded-xl bg-indigo-50 p-3">
                      <p className="font-bold text-indigo-700">Sharpe (샤프 지수)</p>
                      <p className="mt-0.5 text-[11px] text-indigo-600">
                        "위험 대비 얼마나 잘 벌었나?"를 점수로 매긴 거예요.
                        같은 수익이라도 출렁임이 적으면 샤프가 높아요.
                        1.0 이상이면 아주 좋고, 0.5 이상이면 괜찮은 편이에요.
                        가성비 좋은 투자일수록 샤프가 높다고 생각하면 돼요!
                      </p>
                    </div>
                    <div className="rounded-xl bg-purple-50 p-3">
                      <p className="font-bold text-purple-700">배당수익률</p>
                      <p className="mt-0.5 text-[11px] text-purple-600">
                        "가만히 가지고 있기만 해도 매년 받는 용돈(배당금)이 투자금의 몇 %인가?"예요.
                        예를 들어 배당률 3%이면, 1,000만원 투자 시 1년에 약 30만원을 배당으로 받아요.
                        월배당은 이 금액을 12로 나눈 거예요.
                      </p>
                    </div>
                    <div className="rounded-xl bg-amber-50 p-3">
                      <p className="font-bold text-amber-700">ETF (상장지수펀드)</p>
                      <p className="mt-0.5 text-[11px] text-amber-700">
                        여러 주식이나 채권을 하나로 묶은 상품이에요. 주식처럼 사고팔 수 있어요.
                        예를 들어 "KODEX 미국S&P500"은 미국의 큰 회사 500개에 한꺼번에 투자하는 ETF예요.
                      </p>
                    </div>
                    <div className="rounded-xl bg-sky-50 p-3">
                      <p className="font-bold text-sky-700">위험자산 vs 안전자산</p>
                      <p className="mt-0.5 text-[11px] text-sky-600">
                        <b>위험자산</b>: 주식, 금 등 가격이 크게 오르내릴 수 있는 자산. 수익 기대가 높지만 손실 가능성도 커요.<br/>
                        <b>안전자산</b>: 채권, KOFR(단기금리) 등 가격 변동이 적은 자산. 수익은 적지만 안정적이에요.
                        두 가지를 섞으면 수익도 챙기면서 위험도 줄일 수 있어요!
                      </p>
                    </div>
                  </div>
                </section>

                {/* 2. 기본 사용법 */}
                <section>
                  <h3 className="mb-1.5 text-[13px] font-extrabold text-indigo-600">기본 사용법 (3단계)</h3>
                  <div className="space-y-2">
                    <div className="flex gap-2.5">
                      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-black text-indigo-600">1</span>
                      <div>
                        <p className="font-bold text-slate-700">투자금액 입력</p>
                        <p className="text-[11px]">실제로 투자할 금액을 입력하세요. 백만/천만/억 버튼으로 빠르게 추가할 수 있어요.</p>
                      </div>
                    </div>
                    <div className="flex gap-2.5">
                      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-black text-indigo-600">2</span>
                      <div>
                        <p className="font-bold text-slate-700">전략 선택 (A~E)</p>
                        <p className="text-[11px]">
                          <b>A형</b> 연금저축 &nbsp;/&nbsp; <b>B형</b> IRP &nbsp;/&nbsp;
                          <b>C형</b> 성장 &nbsp;/&nbsp; <b>D형</b> 은퇴 &nbsp;/&nbsp; <b>E형</b> 배당<br/>
                          A형·B형은 안정형/중립형/성장형 중 하나를 추가로 선택해요.
                          안정형은 채권 비중이 높아 덜 출렁이고, 성장형은 주식 비중이 높아 수익 기대가 커요.
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2.5">
                      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-black text-indigo-600">3</span>
                      <div>
                        <p className="font-bold text-slate-700">결과 확인</p>
                        <p className="text-[11px]">
                          "시세 조회" 버튼을 누르면 최신 가격으로 각 ETF를 몇 주씩 사야 하는지,
                          예상 월배당은 얼마인지, 포트폴리오 성과(KPI)는 어떤지 자동으로 계산돼요.
                        </p>
                      </div>
                    </div>
                  </div>
                </section>

                {/* 3. 화면별 기능 설명 */}
                <section>
                  <h3 className="mb-1.5 text-[13px] font-extrabold text-indigo-600">화면별 기능 안내</h3>
                  <div className="space-y-3">

                    <div className="rounded-xl border border-slate-100 p-3">
                      <p className="font-bold text-slate-700">시세 조회 상태</p>
                      <p className="text-[11px]">
                        네이버 금융에서 ETF의 최신 가격과 과거 1년 가격을 가져와요.
                        노란 점이 깜빡이면 조회 중, 초록 점이면 완료된 거예요.
                        한번 가져온 데이터는 저장되어 다시 열 때 빠르게 표시돼요.
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-100 p-3">
                      <p className="font-bold text-slate-700">월배당금 상세</p>
                      <p className="text-[11px]">
                        각 ETF가 1년간 주는 배당금을 12로 나눠서 한 달에 받을 예상 배당금을 보여줘요.
                        모든 ETF의 월배당을 합하면 전체 월배당 총액이 됩니다.
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-100 p-3">
                      <p className="font-bold text-slate-700">KPI 비교</p>
                      <p className="text-[11px]">
                        1년/6개월/3개월/1개월 기간별로 포트폴리오의 성과를 비교할 수 있어요.
                        CAGR(수익률), MDD(최대낙폭), Sharpe(위험대비수익), 배당률 4가지를 한눈에 확인하세요.
                        기간 탭을 눌러 다른 기간의 성과도 볼 수 있어요.
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-100 p-3">
                      <p className="font-bold text-slate-700">종목별 상세</p>
                      <p className="text-[11px]">
                        각 ETF의 현재가, 투자금액, 매수 주수, 배당률, 기간별 수익률을 보여줘요.
                        종목 이름을 누르면 상세 정보가 펼쳐져요.
                        "검산 금액"이란 실제로 주식을 살 때의 금액(주수 x 현재가)이에요.
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-100 p-3">
                      <p className="font-bold text-slate-700">전략 비교</p>
                      <p className="text-[11px]">
                        여러 전략의 성과를 표로 비교할 수 있어요.
                        "A~E 비교"는 5개 전략 전체를, "A형 모드"는 A형의 안정/중립/성장을,
                        "S&P500 대비"는 미국 주식과 비교해 줘요.
                        "데이터 조회" 버튼을 누르면 비교 표가 나타납니다.
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-100 p-3">
                      <p className="font-bold text-slate-700">복리 계산기</p>
                      <p className="text-[11px]">
                        "지금 투자한 돈이 10년, 20년 뒤에 얼마가 될까?"를 계산해 줘요.
                        최초 투자금과 매년 추가 투자금을 넣고, CAGR을 입력하면
                        연도별 자산 증가를 그래프와 표로 보여줘요.
                        복리란 "이자에 또 이자가 붙는 것"으로, 시간이 지날수록 자산이 눈덩이처럼 불어나요!
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-100 p-3">
                      <p className="font-bold text-slate-700">B형 1년 수익률 비교</p>
                      <p className="text-[11px]">
                        B형(IRP) 포트폴리오의 안정형/중립형/성장형이 지난 1년간 어떻게 움직였는지
                        그래프로 보여줘요. 파란색이 안정형, 주황색이 중립형, 빨간색이 성장형이에요.
                        100%를 기준으로 위로 올라가면 수익, 아래로 내려가면 손실이에요.
                        퇴직금(DC) 운용 시 어떤 모드를 선택할지 판단하는 데 참고하세요.
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-100 p-3">
                      <p className="font-bold text-slate-700">최적 포트폴리오 탐색</p>
                      <p className="text-[11px]">
                        15개 ETF의 과거 1년 데이터를 분석하여 가장 좋은 조합을 자동으로 찾아줘요.
                        컴퓨터가 수만 가지 조합을 시험해서 가장 높은 수익 + 가장 낮은 위험의 조합을 골라줘요.
                      </p>
                      <p className="mt-1 text-[11px]">
                        적용되는 규칙:
                      </p>
                      <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-[11px]">
                        <li>모든 종목은 19% 이하 (한 종목에 너무 몰리지 않도록)</li>
                        <li>개별 주식 종목은 10% 이하</li>
                        <li>KOFR(현금성) 5% 이상 유지</li>
                        <li>안전자산(채권+현금) 30% 이상 (안정적인 비중 확보)</li>
                        <li>포트폴리오 전체 배당수익률 3~4% 범위</li>
                        <li>주식·금·채권·KOFR 각각 1개 이상 포함</li>
                      </ul>
                      <p className="mt-1 text-[10px] text-slate-400">
                        * 과거 데이터를 기반으로 한 백테스트 결과이며, 미래 수익을 보장하지 않습니다.
                      </p>
                    </div>
                  </div>
                </section>

                {/* 4. 투자 전략 요약 */}
                <section>
                  <h3 className="mb-1.5 text-[13px] font-extrabold text-indigo-600">5가지 전략 한눈에 보기</h3>
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="bg-slate-50">
                          <th className="px-2.5 py-2 text-left font-bold text-slate-500">전략</th>
                          <th className="px-2.5 py-2 text-left font-bold text-slate-500">계좌</th>
                          <th className="px-2.5 py-2 text-left font-bold text-slate-500">특징</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        <tr><td className="px-2.5 py-1.5 font-bold text-indigo-600">A형</td><td className="px-2.5 py-1.5">연금저축</td><td className="px-2.5 py-1.5">주식/채권 균형, 모드 선택 가능</td></tr>
                        <tr><td className="px-2.5 py-1.5 font-bold text-indigo-600">B형</td><td className="px-2.5 py-1.5">IRP</td><td className="px-2.5 py-1.5">A형 대비 채권·혼합 비중 조정, 모드 선택 가능</td></tr>
                        <tr><td className="px-2.5 py-1.5 font-bold text-indigo-600">C형</td><td className="px-2.5 py-1.5">성장</td><td className="px-2.5 py-1.5">글로벌 주식 + 금 분산</td></tr>
                        <tr><td className="px-2.5 py-1.5 font-bold text-indigo-600">D형</td><td className="px-2.5 py-1.5">은퇴</td><td className="px-2.5 py-1.5">커버드콜·혼합 → 현금흐름 강화</td></tr>
                        <tr><td className="px-2.5 py-1.5 font-bold text-indigo-600">E형</td><td className="px-2.5 py-1.5">배당</td><td className="px-2.5 py-1.5">배당/리츠 중심 인컴 전략</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1.5 text-[10px] text-slate-400">
                    A형·B형은 안정형/중립형/성장형 세 가지 모드를 제공합니다.
                    안정형일수록 채권이 많고 변동이 적어요.
                    성장형일수록 주식이 많고 수익 기대가 높아요.
                  </p>
                </section>

                {/* 5. 자주 묻는 질문 */}
                <section>
                  <h3 className="mb-1.5 text-[13px] font-extrabold text-indigo-600">자주 묻는 질문</h3>
                  <div className="space-y-2.5">
                    <div>
                      <p className="font-bold text-slate-700">Q. 시세 조회가 안 돼요!</p>
                      <p className="text-[11px]">네이버 금융 서버 상태에 따라 일시적으로 안 될 수 있어요. 잠시 후 다시 시도해 보세요.</p>
                    </div>
                    <div>
                      <p className="font-bold text-slate-700">Q. 투자금을 바꾸면 어떻게 되나요?</p>
                      <p className="text-[11px]">투자금을 바꾸면 각 ETF에 투자할 금액과 매수 주수가 자동으로 다시 계산돼요.</p>
                    </div>
                    <div>
                      <p className="font-bold text-slate-700">Q. 어떤 전략을 골라야 하나요?</p>
                      <p className="text-[11px]">
                        정답은 없어요! 젊고 장기 투자할 수 있다면 성장형(C형), 안정적 수입이 중요하면 배당형(D·E형),
                        균형을 원하면 A·B형 중립형이 좋은 출발점이에요. "전략 비교" 기능으로 직접 비교해 보세요.
                      </p>
                    </div>
                    <div>
                      <p className="font-bold text-slate-700">Q. 이 앱의 결과를 그대로 따라 투자해도 되나요?</p>
                      <p className="text-[11px]">
                        절대 그대로 따라 하지 마세요! 이 앱은 참고용 도구일 뿐이에요.
                        반드시 본인의 상황과 판단에 따라 투자를 결정하세요.
                        아래 "투자 책임 안내"를 꼭 읽어 주세요.
                      </p>
                    </div>
                  </div>
                </section>

                {/* 6. 투자 책임 안내 */}
                <section>
                  <h3 className="mb-1.5 text-[13px] font-extrabold text-rose-600">투자 책임 안내 (반드시 읽어주세요)</h3>
                  <div className="rounded-xl border-2 border-rose-200 bg-rose-50 p-4 text-[11px] leading-[1.9] text-rose-800">
                    <p className="font-extrabold text-[12px]">
                      본 앱에서 제공하는 모든 포트폴리오(A~E형) 및 최적 포트폴리오 탐색 결과는
                      투자 참고 자료일 뿐이며, 투자 권유가 아닙니다.
                    </p>
                    <p className="mt-2">
                      <b>투자에 대한 최종 결정과 그에 따른 모든 책임은
                      투자자 본인에게 있습니다.</b>
                    </p>
                    <ul className="mt-2 list-inside list-disc space-y-1">
                      <li>본 앱의 정보를 근거로 한 투자 손실에 대해 앱 제작자는 어떠한 책임도 지지 않습니다.</li>
                      <li>과거 수익률은 미래 수익을 보장하지 않습니다.</li>
                      <li>
                        <b>특히 "최적 포트폴리오 탐색"은 과거 1년 데이터만을 기반으로 한
                        백테스트 결과</b>이므로, 향후 시장 상황에 따라 결과가 크게 달라질 수 있습니다.
                        최적 포트폴리오 결과를 맹신하지 마세요.
                      </li>
                      <li>ETF 가격, 배당률 등 데이터는 네이버 금융에서 가져오며, 실시간 정확성을 보장하지 않습니다.</li>
                    </ul>
                    <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-amber-800">
                      <p className="font-extrabold text-[12px]">퇴직 예정자분께 드리는 안내</p>
                      <p className="mt-1">
                        퇴직을 앞두고 계신 분은 최적 포트폴리오 탐색보다
                        <b> A형(연금저축)과 B형(IRP) 포트폴리오를 우선 활용</b>하시길 권장합니다.
                        A·B형은 검증된 분산 투자 구조로 설계되어 있으며,
                        안정형/중립형/성장형 모드를 통해 본인의 위험 감수 수준에 맞게 조절할 수 있습니다.
                        퇴직금은 한번 잃으면 되돌리기 어려우므로 보수적으로 운용하시는 것을 추천드립니다.
                      </p>
                    </div>
                  </div>
                </section>

                {/* 닫기 버튼 */}
                <button
                  type="button"
                  onClick={() => setShowManual(false)}
                  className="btn-primary w-full"
                >
                  닫기
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── 투자 조건 선택 ── */}
        <section className="ios-card px-3.5 py-3.5">
          <h2 className="text-[13px] font-bold text-slate-700">투자 조건 선택</h2>

          <div className="mt-2.5 space-y-3">
            {/* 투자금액 */}
            <div>
              <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">투자금액</p>
              <input
                className="ios-input text-right text-sm font-bold"
                inputMode="decimal"
                value={
                  principalFocused
                    ? selection.principal === 0
                      ? ""
                      : String(selection.principal)
                    : selection.principal.toLocaleString("ko-KR")
                }
                onFocus={(e) => {
                  setPrincipalFocused(true);
                  e.currentTarget.select();
                }}
                onBlur={() => setPrincipalFocused(false)}
                onChange={(e) =>
                  setSelection((prev) => ({
                    ...prev,
                    principal: sanitizeNonNegativeNumber(
                      Number(e.target.value.replace(/[^0-9.]/g, "")) || 0,
                      0
                    ),
                  }))
                }
              />
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {PRINCIPAL_QUICK_ADD.map((quick) => (
                  <button
                    key={quick.label}
                    type="button"
                    onClick={() =>
                      setSelection((prev) => ({
                        ...prev,
                        principal: sanitizeNonNegativeNumber(prev.principal + quick.amount, 0),
                      }))
                    }
                    className="btn-ghost"
                  >
                    +{quick.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 투자방식 */}
            <div>
              <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">투자방식</p>
              <div className="grid grid-cols-5 gap-1.5">
                {(["A", "B", "C", "D", "E"] as StrategyType[]).map((strategy) => {
                  const active = selection.strategy === strategy;
                  return (
                    <button
                      key={strategy}
                      type="button"
                      onClick={() =>
                        setSelection((prev) => ({
                          ...prev,
                          strategy,
                          mode:
                            strategy === "A" || strategy === "B"
                              ? (prev.mode ?? "중립형")
                              : null,
                        }))
                      }
                      className={`rounded-lg border py-2 text-[13px] font-bold transition ${
                        active
                          ? "border-brand-500 bg-brand-500 text-white shadow-glow"
                          : "border-slate-200 bg-white text-slate-500 hover:border-brand-300"
                      }`}
                    >
                      {strategy}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] text-slate-400">
                <span className="font-semibold text-slate-600">{selection.strategy}</span> · {strategyDescriptions[selection.strategy]}
              </p>
            </div>

            {/* 투자성향 */}
            {requiresMode && (
              <div>
                <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">투자성향</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["안정형", "중립형", "성장형"] as PortfolioMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSelection((prev) => ({ ...prev, mode }))}
                      className={`mode-btn mode-${mode} ${selection.mode === mode ? "active" : ""}`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* KPI 기간 */}
            <div>
              <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">KPI 기간</p>
              <div className="grid grid-cols-4 gap-1.5">
                {KPI_WINDOW_LIST.map((window) => {
                  const active = selection.kpiWindow === window;
                  return (
                    <button
                      key={window}
                      type="button"
                      onClick={() => setSelection((prev) => ({ ...prev, kpiWindow: window }))}
                      className={`rounded-lg border py-1.5 text-[11px] font-bold transition ${
                        active
                          ? "border-brand-500 bg-brand-500 text-white"
                          : "border-slate-200 bg-white text-slate-500 hover:border-brand-300"
                      }`}
                    >
                      {KPI_WINDOW_LABELS[window]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 결과 보기 */}
            <button
              type="button"
              onClick={handleShowResult}
              disabled={!canShowResult || isRefreshing}
              className="btn-primary w-full"
            >
              {isRefreshing ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-r-transparent" />
                  조회 진행 중...
                </>
              ) : "결과 보기"}
            </button>
          </div>
        </section>

        {/* ── 결과 섹션 ── */}
        {resultPortfolio && appliedSelection && (
          <>
            {/* 핵심 요약 카드 (항상 표시) */}
            <section className="ios-card px-3.5 py-3 animate-fade-in">
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap gap-1">
                  <span className="chip bg-brand-100 text-brand-700">{formatCurrencyKRW(appliedSelection.principal)}</span>
                  <span className="chip bg-slate-100 text-slate-600">{appliedSelection.strategy}형{(appliedSelection.strategy === "A" || appliedSelection.strategy === "B") ? ` · ${appliedSelection.mode}` : ""}</span>
                  <span className="chip bg-slate-100 text-slate-600">{KPI_WINDOW_LABELS[appliedSelection.kpiWindow]}</span>
                </div>
                <button type="button" onClick={handleRefreshLatest} disabled={isRefreshing} className="btn-ghost !px-2 !py-1 !text-[10px] disabled:opacity-50">
                  {isRefreshing ? "조회중" : "새로고침"}
                </button>
              </div>

              {/* 핵심 지표 3열 */}
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                <div className="text-center">
                  <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">종목</p>
                  <p className="num text-[14px] font-extrabold text-slate-800">{resultRows.length}<span className="text-[10px] font-semibold">개</span></p>
                </div>
                <div className="text-center">
                  <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">비중합계</p>
                  <p className="num text-[14px] font-extrabold text-slate-800">{formatPercent(weightSum)}</p>
                </div>
                <div className="text-center">
                  <p className="text-[9px] font-bold uppercase tracking-wide text-emerald-500">월배당</p>
                  <p className="num text-[14px] font-extrabold text-brand-600">
                    {monthlyDividendBySelectedWindow != null ? formatCurrencyKRW(monthlyDividendBySelectedWindow) : "-"}
                  </p>
                </div>
              </div>
            </section>

            {/* 진행 상태 (접기) */}
            <details className="ios-card ios-section overflow-hidden animate-fade-in" open={isRefreshing || undefined}>
              <summary className="flex items-center justify-between px-3.5 py-2.5">
                <div className="flex items-center gap-2">
                  {isRefreshing && <span className="status-dot status-dot-loading" />}
                  {!isRefreshing && refreshState.stage === "done" && <span className="status-dot status-dot-ok" />}
                  <span className="text-[12px] font-semibold text-slate-700">
                    {isRefreshing ? refreshStageText[refreshState.stage] : `갱신 완료 · ${refreshState.lastUpdatedAt ?? "-"}`}
                  </span>
                </div>
                <span className="chevron">▾</span>
              </summary>
              <div className="section-body border-t border-slate-100 px-3.5 py-2.5">
                <p className="text-[11px] text-slate-500">{refreshMessage}</p>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-brand-100">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isRefreshing ? "animate-pulse bg-gradient-to-r from-brand-500 via-brand-400 to-brand-300" : "bg-brand-400"
                    }`}
                    style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }}
                  />
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1 text-[10px] text-slate-400">
                  <p>단계: <span className="font-semibold text-slate-600">{refreshStageText[refreshState.stage]}</span></p>
                  <p>진행: <span className="font-semibold text-slate-600 num">{progressPercent}%</span></p>
                  <p>시세: <span className="font-semibold text-slate-600 num">{refreshState.priceSuccess}/{refreshState.priceFailed}</span></p>
                  <p>KPI: <span className="font-semibold text-slate-600 num">{refreshState.kpiSuccess}/{refreshState.kpiFailed}</span></p>
                </div>
              </div>
            </details>

            {/* 월배당금 상세 (접기) */}
            <details className="ios-card ios-section overflow-hidden animate-fade-in">
              <summary className="flex items-center justify-between px-3.5 py-2.5">
                <span className="text-[12px] font-semibold text-slate-700">월배당금 상세</span>
                <div className="flex items-center gap-2">
                  <span className="num text-[12px] font-bold text-brand-600">
                    {monthlyDividendBySelectedWindow != null ? formatCurrencyKRW(monthlyDividendBySelectedWindow) : "-"}
                  </span>
                  <span className="chevron">▾</span>
                </div>
              </summary>
              <div className="section-body border-t border-slate-100 px-3.5 py-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="metric-label">배당률</p>
                    <p className="num text-[13px] font-bold text-emerald-600">
                      {selectedWindowKpi != null ? formatPercent(selectedWindowKpi.annualDividendYield) : "-"}
                    </p>
                  </div>
                  <div>
                    <p className="metric-label">연배당금</p>
                    <p className="num text-[13px] font-bold text-slate-700">
                      {annualDividendBySelectedWindow != null ? formatCurrencyKRW(annualDividendBySelectedWindow) : "-"}
                    </p>
                  </div>
                </div>
                <p className="mt-1.5 text-[9px] text-slate-400">KPI 기간 실데이터 배당률 × 투자금액</p>
              </div>
            </details>

            {/* KPI 비교 (접기) */}
            <details className="ios-card ios-section overflow-hidden animate-fade-in">
              <summary className="flex items-center justify-between px-3.5 py-2.5">
                <span className="text-[12px] font-semibold text-slate-700">KPI 비교 · {activeKpiLabel}</span>
                <div className="flex items-center gap-2">
                  <span className="num text-[11px] font-bold text-emerald-600">
                    CAGR {selectedWindowKpi ? formatPercent(selectedWindowKpi.cagr) : "-"}
                  </span>
                  <span className="chevron">▾</span>
                </div>
              </summary>
              <div className="section-body border-t border-slate-100 px-3.5 py-2.5">
                <p className="text-[9px] text-slate-400">
                  배당 재투자 기준 · {selectedKpiPeriod
                    ? `${formatYmdFromDashDate(selectedKpiPeriod.start)}~${formatYmdFromDashDate(selectedKpiPeriod.end)}`
                    : "-"}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                    <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">평균 KPI</p>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]"><span className="text-slate-400">CAGR</span><span className="num font-bold text-emerald-600">{averageKpi ? formatPercent(averageKpi.cagr) : "-"}</span></div>
                      <div className="flex justify-between text-[11px]"><span className="text-slate-400">MDD</span><span className="num font-bold text-rose-500">{averageKpi ? formatPercent(averageKpi.mdd) : "-"}</span></div>
                      <div className="flex justify-between text-[11px]"><span className="text-slate-400">Sharpe</span><span className="num font-bold text-brand-600">{averageKpi ? averageKpi.sharpe.toFixed(2) : "-"}</span></div>
                      <div className="flex justify-between text-[11px]"><span className="text-slate-400">배당률</span><span className="num font-bold text-slate-600">{averageKpi ? formatPercent(averageKpi.annualDividendYield) : "-"}</span></div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                    <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">{activeKpiLabel} KPI</p>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]"><span className="text-slate-400">CAGR</span><span className="num font-bold text-emerald-600">{selectedWindowKpi ? formatPercent(selectedWindowKpi.cagr) : "-"}</span></div>
                      <div className="flex justify-between text-[11px]"><span className="text-slate-400">MDD</span><span className="num font-bold text-rose-500">{selectedWindowKpi ? formatPercent(selectedWindowKpi.mdd) : "-"}</span></div>
                      <div className="flex justify-between text-[11px]"><span className="text-slate-400">Sharpe</span><span className="num font-bold text-brand-600">{selectedWindowKpi ? selectedWindowKpi.sharpe.toFixed(2) : "-"}</span></div>
                      <div className="flex justify-between text-[11px]"><span className="text-slate-400">배당률</span><span className="num font-bold text-slate-600">{selectedWindowKpi ? formatPercent(selectedWindowKpi.annualDividendYield) : "-"}</span></div>
                    </div>
                  </div>
                </div>
              </div>
            </details>

            {/* 종목 상세 (접기/펴기) */}
            <details className="ios-card ios-section overflow-hidden animate-fade-in" open>
              <summary className="flex items-center justify-between px-3.5 py-2.5">
                <span className="text-[12px] font-semibold text-slate-700">종목별 상세 ({resultRows.length})</span>
                <div className="flex items-center gap-2">
                  <span className="num text-[11px] font-bold text-slate-500">{formatCurrencyKRW(totalCheckAmount)}</span>
                  <span className="chevron">▾</span>
                </div>
              </summary>
              <div className="section-body border-t border-slate-100">
                <div className="space-y-px">
                  {resultRows.map(({ item, quantity, amount, priceFetchedDate, periodReturnByWindow, appliedDividendYield }) => (
                    <details key={item.id} className="group">
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2 hover:bg-slate-50/80">
                        <span className="inline-block min-w-[32px] rounded bg-brand-50 px-1 py-0.5 text-center text-[9px] font-bold text-brand-600">
                          {formatPercent(item.weight)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-700">{item.name}</span>
                        <span className="num shrink-0 text-[13px] font-extrabold text-slate-800">{formatNumber(quantity)}<span className="text-[10px] font-semibold text-slate-500">주</span></span>
                      </summary>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 bg-slate-50/70 px-3.5 py-2 text-[10px] text-slate-400">
                        <p>현재가 <span className="num font-semibold text-slate-700">{formatCurrencyKRW(item.price)}</span></p>
                        <p>투자금액 <span className="num font-semibold text-slate-700">{formatCurrencyKRW(amount)}</span></p>
                        <p>배당률 <span className="num font-semibold text-slate-700">{formatPercent(appliedDividendYield)}</span></p>
                        <p>조회일 <span className="font-semibold text-slate-700">{priceFetchedDate ?? "-"}</span></p>
                        <p>1Y <span className="num font-semibold text-slate-700">{periodReturnByWindow["1Y"] != null ? formatPercent(periodReturnByWindow["1Y"]) : "-"}</span></p>
                        <p>6M <span className="num font-semibold text-slate-700">{periodReturnByWindow["6M"] != null ? formatPercent(periodReturnByWindow["6M"]) : "-"}</span></p>
                        <p>3M <span className="num font-semibold text-slate-700">{periodReturnByWindow["3M"] != null ? formatPercent(periodReturnByWindow["3M"]) : "-"}</span></p>
                        <p>1M <span className="num font-semibold text-slate-700">{periodReturnByWindow["1M"] != null ? formatPercent(periodReturnByWindow["1M"]) : "-"}</span></p>
                      </div>
                    </details>
                  ))}
                </div>

                {/* 검산 */}
                <div className="border-t border-slate-100 px-3.5 py-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-400">검산 차이</span>
                    <span className={`num font-bold ${roundingGap > 0 ? "text-emerald-600" : roundingGap < 0 ? "text-rose-600" : "text-slate-500"}`}>
                      {formatSignedCurrencyKRW(roundingGap)} <span className="font-normal text-slate-400">({roundingGapLabel})</span>
                    </span>
                  </div>
                </div>
              </div>
            </details>

            {/* 전략 비교 (접기) */}
            <details className="ios-card ios-section overflow-hidden animate-fade-in">
              <summary className="flex items-center justify-between px-3.5 py-2.5">
                <span className="text-[12px] font-semibold text-slate-700">전략 비교</span>
                <span className="chevron">▾</span>
              </summary>
              <div className="section-body border-t border-slate-100 px-3.5 py-2.5">
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { mode: "ABCDE" as StrategyCompareMode, label: `ABCDE` },
                    { mode: "A_MODES" as StrategyCompareMode, label: `A 성향별` },
                    { mode: "B_MODES" as StrategyCompareMode, label: `B 성향별` },
                    { mode: "A_GROWTH_SP500" as StrategyCompareMode, label: `A vs S&P` },
                  ].map(({ mode, label }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => void handleCompareOneYearKpi(mode)}
                      disabled={strategyCompareLoading}
                      className={`rounded-lg border px-2 py-2 text-[11px] font-bold transition disabled:opacity-50 ${
                        strategyCompareMode === mode
                          ? "border-brand-500 bg-brand-500 text-white"
                          : "border-brand-200 bg-brand-50 text-brand-700"
                      }`}
                    >
                      {strategyCompareLoading && strategyCompareMode === mode ? "..." : label}
                    </button>
                  ))}
                </div>

                {strategyCompareMode && !strategyCompareError && strategyCompareRows.length > 0 && (
                  <div className="mt-2 max-h-[300px] overflow-auto rounded-lg border border-slate-100">
                    <table className="ios-table min-w-[560px]">
                      <thead>
                        <tr>
                          <th className="sticky left-0 top-0 z-30 w-[64px] min-w-[64px] border-r border-slate-200 bg-slate-50 text-left">구분</th>
                          <th className="sticky top-0 z-20 text-right">CAGR</th>
                          <th className="sticky top-0 z-20 text-right">MDD</th>
                          <th className="sticky top-0 z-20 text-right">Sharpe</th>
                          <th className="sticky top-0 z-20 text-right">배당률</th>
                          <th className="sticky top-0 z-20 text-right">월배당</th>
                        </tr>
                      </thead>
                      <tbody>
                        {strategyCompareRows.map((row) => (
                          <tr key={row.id}>
                            <td className="sticky left-0 z-10 w-[64px] min-w-[64px] border-r border-slate-100 bg-white px-2 py-2 text-[11px] font-semibold text-slate-700">{row.label}</td>
                            <td className="num px-2 py-2 text-right text-[11px] text-slate-600">{row.kpi ? formatPercent(row.kpi.cagr) : "-"}</td>
                            <td className="num px-2 py-2 text-right text-[11px] text-slate-600">{row.kpi ? formatPercent(row.kpi.mdd) : "-"}</td>
                            <td className="num px-2 py-2 text-right text-[11px] text-slate-600">{row.kpi ? row.kpi.sharpe.toFixed(2) : "-"}</td>
                            <td className="num px-2 py-2 text-right text-[11px] text-slate-600">{row.kpi ? formatPercent(row.kpi.annualDividendYield) : "-"}</td>
                            <td className="num px-2 py-2 text-right text-[11px] font-semibold text-brand-700">{row.monthlyDividend != null ? formatCurrencyKRW(row.monthlyDividend) : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {strategyCompareError && <p className="mt-2 text-[11px] font-semibold text-rose-600">{strategyCompareError}</p>}
              </div>
            </details>
          </>
        )}

        {/* ── 복리 계산기 (접기) ── */}
        <details className="ios-card ios-section overflow-hidden">
          <summary className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-[12px] font-semibold text-slate-700">복리 계산기</span>
            <div className="flex items-center gap-2">
              {compoundFinal.totalAsset > 0 && (
                <span className="num text-[11px] font-bold text-brand-600">{formatCompactKrw(compoundFinal.totalAsset)}</span>
              )}
              <span className="chevron">▾</span>
            </div>
          </summary>
          <div className="section-body border-t border-slate-100 px-3.5 py-3">
            <div className="space-y-3">
              {/* 최초 투자원금 */}
              <div>
                <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">최초 투자원금</p>
                <input
                  className="ios-input text-right text-sm font-bold"
                  inputMode="decimal"
                  value={
                    compoundInitialFocused
                      ? compoundInitialPrincipal === 0
                        ? ""
                        : String(compoundInitialPrincipal)
                      : compoundInitialPrincipal.toLocaleString("ko-KR")
                  }
                  onFocus={(event) => {
                    setCompoundInitialFocused(true);
                    event.currentTarget.select();
                  }}
                  onBlur={() => setCompoundInitialFocused(false)}
                  onChange={(event) =>
                    setCompoundInitialPrincipal(
                      sanitizeNonNegativeNumber(
                        Number(event.target.value.replace(/[^0-9.]/g, "")) || 0,
                        0
                      )
                    )
                  }
                />
                <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                  {COMPOUND_INITIAL_QUICK_ADD.map((quick) => (
                    <button
                      key={quick.label}
                      type="button"
                      onClick={() =>
                        setCompoundInitialPrincipal((prev) =>
                          sanitizeNonNegativeNumber(prev + quick.amount, 0)
                        )
                      }
                      className="btn-ghost"
                    >
                      +{quick.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 매년 추가원금 */}
              <div>
                <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">매년 추가원금</p>
                <input
                  className="ios-input text-right text-sm font-bold"
                  inputMode="decimal"
                  value={
                    compoundAnnualFocused
                      ? compoundAnnualContribution === 0
                        ? ""
                        : String(compoundAnnualContribution)
                      : compoundAnnualContribution.toLocaleString("ko-KR")
                  }
                  onFocus={(event) => {
                    setCompoundAnnualFocused(true);
                    event.currentTarget.select();
                  }}
                  onBlur={() => setCompoundAnnualFocused(false)}
                  onChange={(event) =>
                    setCompoundAnnualContribution(
                      sanitizeNonNegativeNumber(
                        Number(event.target.value.replace(/[^0-9.]/g, "")) || 0,
                        0
                      )
                    )
                  }
                />
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {COMPOUND_ANNUAL_QUICK_ADD.map((quick) => (
                    <button
                      key={quick.label}
                      type="button"
                      onClick={() =>
                        setCompoundAnnualContribution((prev) =>
                          sanitizeNonNegativeNumber(prev + quick.amount, 0)
                        )
                      }
                      className="btn-ghost"
                    >
                      +{quick.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 수익률 + 기간 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">목표 수익률 %</p>
                  <input
                    className="ios-input text-right text-sm font-bold"
                    inputMode="decimal"
                    value={compoundTargetReturn}
                    onChange={(event) =>
                      setCompoundTargetReturn(
                        sanitizeNonNegativeNumber(
                          Number(event.target.value.replace(/[^0-9.]/g, "")) || 0,
                          0
                        )
                      )
                    }
                  />
                </div>
                <div>
                  <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">기간 (년)</p>
                  <input
                    className="ios-input text-right text-sm font-bold"
                    inputMode="numeric"
                    value={compoundYears}
                    onChange={(event) =>
                      setCompoundYears(
                        Math.floor(
                          sanitizeNonNegativeNumber(
                            Number(event.target.value.replace(/[^0-9.]/g, "")) || 0,
                            0
                          )
                        )
                      )
                    }
                  />
                </div>
              </div>
            </div>

            {/* 결과 */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="metric-card">
                <p className="metric-label">누적 원금</p>
                <p className="metric-value text-slate-700">{formatCompactKrw(compoundFinal.principalSum)}</p>
              </div>
              <div className="metric-card">
                <p className="metric-label">총 자산</p>
                <p className="metric-value text-brand-600">{formatCompactKrw(compoundFinal.totalAsset)}</p>
              </div>
              <div className="metric-card">
                <p className="metric-label">수익금</p>
                <p className={`metric-value ${compoundFinal.profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {formatCompactKrw(compoundFinal.profit)}
                </p>
              </div>
              <div className="metric-card">
                <p className="metric-label">수익률</p>
                <p className="num metric-value text-slate-700">{formatPercent(compoundTotalReturnPercent)}</p>
              </div>
            </div>

            {/* 그래프 */}
            <div className="mt-2 overflow-hidden rounded-lg border border-brand-100 bg-gradient-to-br from-brand-50 to-white p-2">
              <svg viewBox={`0 0 ${compoundChart.width} ${compoundChart.height}`} className="h-32 w-full">
                <polygon points={compoundChart.area} fill="rgba(99,102,241,0.06)" />
                <polyline points={compoundChart.principalLine} fill="none" stroke="rgba(148,163,184,0.6)" strokeWidth="1.2" strokeDasharray="3 3" />
                <polyline points={compoundChart.assetLine} fill="none" stroke="#6366F1" strokeWidth="2" />
              </svg>
              <div className="flex items-center justify-between text-[9px] text-slate-400">
                {compoundChart.labels.map((label) => <span key={label.key}>{label.label}</span>)}
              </div>
              <div className="mt-1 flex items-center gap-3 text-[9px] text-slate-400">
                <span className="inline-flex items-center gap-1"><span className="inline-block h-px w-3 rounded bg-brand-500" />총 자산</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block h-px w-3 rounded border-t border-dashed border-slate-400" />원금</span>
              </div>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">{compoundEvaluationText}</p>
          </div>
        </details>

        {/* ── B형 1년 수익률 비교 그래프 ── */}
        <details className="ios-card ios-section">
          <summary className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold text-slate-700">B형 1년 수익률 비교</span>
              <span className="chip bg-rose-50 text-rose-600">DC 퇴직금</span>
            </div>
            <span className="chevron">▼</span>
          </summary>
          <div className="section-body px-3.5 pb-3.5">
            <p className="mb-2.5 text-[10px] leading-relaxed text-slate-400">
              B형(IRP) 안정·중립·성장형의 최근 1년 주간 포트폴리오 수익률 추이입니다.
              1년 전 100% 투자 기준으로 변동폭을 비교하여 향후 투자성향 변경을 판단하세요.
            </p>

            <button
              type="button"
              onClick={handleLoadBModeChart}
              disabled={bModeChartLoading}
              className={`btn-primary w-full ${bModeChartData ? "!bg-slate-600" : ""}`}
            >
              {bModeChartLoading
                ? "데이터 조회 중..."
                : bModeChartData
                  ? "그래프 닫기"
                  : "B형 1년 수익률 그래프 보기"}
            </button>

            {bModeChartError && (
              <p className="mt-2 text-[10px] font-semibold text-rose-500">{bModeChartError}</p>
            )}

            {bModeChart && (
              <div className="mt-3 animate-fade-in">
                {/* 범례 */}
                <div className="mb-2 flex items-center justify-center gap-3">
                  {bModeChart.lines.map((line) => (
                    <span key={line.mode} className="inline-flex items-center gap-1 text-[10px] font-bold" style={{ color: line.color }}>
                      <span className="inline-block h-[3px] w-3.5 rounded-full" style={{ background: line.color }} />
                      {line.mode}
                      <span className="num font-extrabold">{line.lastValue.toFixed(1)}%</span>
                    </span>
                  ))}
                </div>

                {/* 차트 */}
                <div className="overflow-hidden rounded-lg border border-brand-100 bg-gradient-to-br from-slate-50 to-white p-2">
                  <svg viewBox={`0 0 ${bModeChart.width} ${bModeChart.height}`} className="h-40 w-full">
                    {/* 100% 기준선 */}
                    <line
                      x1={bModeChart.padX}
                      y1={bModeChart.baselineY}
                      x2={bModeChart.width - bModeChart.padX}
                      y2={bModeChart.baselineY}
                      stroke="#94A3B8"
                      strokeWidth="0.6"
                      strokeDasharray="3 2"
                    />
                    <text
                      x={bModeChart.padX - 2}
                      y={bModeChart.baselineY - 3}
                      fill="#94A3B8"
                      fontSize="8"
                      textAnchor="start"
                    >
                      100%
                    </text>

                    {/* y축 상한/하한 */}
                    <text x={bModeChart.padX - 2} y={bModeChart.padY - 2} fill="#94A3B8" fontSize="7" textAnchor="start">
                      {bModeChart.chartMax.toFixed(0)}%
                    </text>
                    <text x={bModeChart.padX - 2} y={bModeChart.height - bModeChart.padY + 10} fill="#94A3B8" fontSize="7" textAnchor="start">
                      {bModeChart.chartMin.toFixed(0)}%
                    </text>

                    {/* 3개 라인 */}
                    {bModeChart.lines.map((line) => (
                      <polyline
                        key={line.mode}
                        points={line.points}
                        fill="none"
                        stroke={line.color}
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ))}
                  </svg>

                  {/* x축 라벨 */}
                  <div className="flex items-center justify-between text-[9px] text-slate-400">
                    <span>{bModeChart.startLabel}</span>
                    <span>{bModeChart.endLabel}</span>
                  </div>
                </div>

                {/* 요약 평가 */}
                <div className="mt-2 space-y-1">
                  {bModeChart.lines.map((line) => {
                    const ret = line.lastValue - 100;
                    return (
                      <div key={line.mode} className="flex items-center justify-between text-[11px]">
                        <span className="font-bold" style={{ color: line.color }}>{line.mode}</span>
                        <span className={`num font-extrabold ${ret >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {ret >= 0 ? "+" : ""}{ret.toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </details>

        {/* ── 최적 포트폴리오 탐색 ── */}
        <details className="ios-card ios-section">
          <summary className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold text-slate-700">최적 포트폴리오 탐색</span>
              <span className="chip bg-brand-50 text-brand-600">1Y 백테스트</span>
            </div>
            <span className="chevron">▼</span>
          </summary>
          <div className="section-body px-3.5 pb-3.5">
            <p className="mb-2.5 text-[10px] leading-relaxed text-slate-400">
              15개 ETF의 과거 1년 데이터를 활용하여 최적 조합을 탐색합니다.
              제약: 모든 종목 &lt;20% · 개별 주식 ≤10% · KOFR ≥5% · 안전자산 ≥30% · 배당 3~4% · 주식·금·채권·KOFR 각 1개 이상.
              우선순위: ① CAGR 최대 ② MDD 최소 ③ 배당 수익률
            </p>

            <button
              type="button"
              onClick={handleFindOptimal}
              disabled={optimalLoading}
              className={`btn-primary w-full ${optimalResults ? "!bg-slate-600" : ""}`}
            >
              {optimalLoading
                ? "탐색 중… (1~3초 소요)"
                : optimalResults
                  ? "결과 닫기"
                  : "최적 포트폴리오 탐색 시작"}
            </button>

            {optimalError && (
              <p className="mt-2 text-[10px] font-semibold text-rose-500">{optimalError}</p>
            )}

            {optimalResults && (
              <div className="mt-3 space-y-3 animate-fade-in">
                {optimalResults.map((r) => {
                  const rankColors = ["text-amber-500", "text-slate-400", "text-amber-700"];
                  const rankBg = ["bg-amber-50 border-amber-200", "bg-slate-50 border-slate-200", "bg-orange-50 border-orange-200"];
                  const sortedItems = [...r.items].sort((a, b) => b.weight - a.weight);

                  return (
                    <div key={r.rank} className={`rounded-xl border p-3 ${rankBg[r.rank - 1] ?? "bg-white border-slate-200"}`}>
                      {/* 순위 + 점수 */}
                      <div className="flex items-center justify-between">
                        <span className={`text-[13px] font-black ${rankColors[r.rank - 1] ?? "text-slate-500"}`}>
                          #{r.rank}
                        </span>
                        <span className="text-[9px] font-bold text-slate-400">
                          종합점수 <span className="num">{r.score.toFixed(1)}</span>
                        </span>
                      </div>

                      {/* KPI 그리드 */}
                      <div className="mt-2 grid grid-cols-4 gap-1.5">
                        <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center">
                          <p className="text-[8px] font-bold uppercase text-emerald-400">CAGR</p>
                          <p className="num text-[13px] font-black text-emerald-600">{formatPercent(r.kpi.cagr)}</p>
                        </div>
                        <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center">
                          <p className="text-[8px] font-bold uppercase text-rose-400">MDD</p>
                          <p className="num text-[13px] font-black text-rose-600">-{formatPercent(r.kpi.mdd)}</p>
                        </div>
                        <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center">
                          <p className="text-[8px] font-bold uppercase text-brand-400">Sharpe</p>
                          <p className="num text-[13px] font-black text-brand-600">{r.kpi.sharpe.toFixed(2)}</p>
                        </div>
                        <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center">
                          <p className="text-[8px] font-bold uppercase text-violet-400">배당</p>
                          <p className="num text-[13px] font-black text-violet-600">{formatPercent(r.kpi.annualDividendYield)}</p>
                        </div>
                      </div>

                      {/* 종목 리스트 */}
                      <div className="mt-2 space-y-0.5">
                        {sortedItems.map((item) => (
                          <div key={item.code} className="flex items-center gap-1.5 text-[10px]">
                            <span className={`inline-block w-[32px] shrink-0 rounded-md py-0.5 text-center text-[9px] font-bold text-white ${
                              item.category === "안전자산" ? "bg-sky-400" : "bg-rose-400"
                            }`}>
                              {item.weight}%
                            </span>
                            <span className="truncate font-semibold text-slate-600">{item.name}</span>
                            <span className="ml-auto shrink-0 text-[9px] text-slate-400">{item.subCategory}</span>
                          </div>
                        ))}
                      </div>

                      {/* 기간 + 자산 비중 */}
                      <div className="mt-2 flex items-center justify-between text-[9px] text-slate-400">
                        <span>
                          {formatYmdFromDashDate(r.periodStart)} ~ {formatYmdFromDashDate(r.periodEnd)}
                        </span>
                        <span>
                          안전 <span className="num font-bold text-sky-500">{r.safeWeight}%</span>
                          {" / "}위험 <span className="num font-bold text-rose-500">{100 - r.safeWeight}%</span>
                        </span>
                      </div>
                    </div>
                  );
                })}

                <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5">
                  <p className="text-[10px] font-bold leading-relaxed text-rose-700">
                    ※ 과거 1년 데이터 기반의 백테스트 결과이며 미래 수익을 보장하지 않습니다.
                    투자 판단의 참고 자료일 뿐, 투자 권유가 아닙니다.
                    모든 투자 결정과 책임은 투자자 본인에게 있습니다.
                  </p>
                  <p className="mt-1 text-[9px] leading-relaxed text-rose-500">
                    퇴직 예정자는 최적 포트폴리오보다 A형·B형 포트폴리오를 우선 활용하시길 권장합니다.
                  </p>
                </div>
                <p className="mt-1.5 text-[9px] leading-relaxed text-slate-400">
                  5% 단위 비중 그리드 → 정밀 탐색, 모든 종목 &lt;20%, 개별 주식 ≤10%, KOFR ≥5%, 안전자산 ≥30%, 배당 3~4%, 배당 재투자 반영 CAGR.
                </p>
              </div>
            )}
          </div>
        </details>

        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
          <p className="text-center text-[9px] font-semibold leading-relaxed text-slate-500">
            본 앱의 모든 정보는 투자 참고용이며, 투자 권유가 아닙니다.
            투자 결정과 그에 따른 책임은 전적으로 투자자 본인에게 있습니다.
          </p>
          <p className="mt-1.5 text-center text-[8px] leading-relaxed text-slate-400">
            A형·B형 포트폴리오는 「마법의 연금 굴리기」(저자: 김성일) 서적을
            참고하여 구성하였습니다. 해당 서적의 저작권은 저자에게 있습니다.
          </p>
        </div>
        <p className="pb-1 pt-0.5 text-center text-[9px] tracking-wider text-slate-400">
          {PRODUCED_BY_LABEL}
        </p>
      </div>
    </div>
  );
}

export default App;
