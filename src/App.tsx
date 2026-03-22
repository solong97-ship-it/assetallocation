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
    const cachedQuotes = getStoredLatestQuotesByCodes(codes);
    const codesToFetch = codes.filter(
      (code) => !isStoredLatestQuoteFresh(cachedQuotes[code], STARTUP_PRICE_MAX_AGE_MS)
    );
    if (codesToFetch.length === 0) return;

    let cancelled = false;
    void fetchPricesByCodes(codesToFetch)
      .then(({ prices, sourceByCode }) => {
        if (cancelled) return;
        upsertStoredLatestQuotes(prices, sourceByCode);
      })
      .catch(() => {
        // background warm-up failure is ignored and handled on explicit refresh
      });

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
          <h1 className="text-[15px] font-black tracking-tight text-white">절세계좌 자산배분 투자</h1>
          <p className="mt-1 text-[11px] leading-relaxed text-white/70">
            투자금·전략(A~E) 선택 → 최신 시세 반영 · KPI · 월배당 · 검산
          </p>
        </header>

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
              15개 ETF의 과거 1년 데이터를 활용하여 주식·금·채권·KOFR을 포함한 최적 조합을 탐색합니다.
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

                <p className="text-[9px] leading-relaxed text-slate-400">
                  ※ 과거 1년 백테스트 결과이며 미래 수익을 보장하지 않습니다.
                  5% 단위 비중 그리드 탐색, 배당 재투자 반영 CAGR 기준.
                </p>
              </div>
            )}
          </div>
        </details>

        <p className="pb-1 pt-1 text-center text-[9px] tracking-wider text-slate-400">
          {PRODUCED_BY_LABEL}
        </p>
      </div>
    </div>
  );
}

export default App;
