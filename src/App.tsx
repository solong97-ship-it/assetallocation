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
  const [strategyComparePrincipal, setStrategyComparePrincipal] = useState<number | null>(null);
  const [strategyCompareUpdatedAt, setStrategyCompareUpdatedAt] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>(() => createInitialRefreshState());
  const [refreshMessage, setRefreshMessage] = useState("선택 후 결과 보기를 누르세요.");
  const refreshIdRef = useRef(0);
  const startupWarmupStartedRef = useRef(false);

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
  const refreshActionLabel =
    refreshState.stage === "price"
      ? "시세 조회 중..."
      : refreshState.stage === "kpi"
        ? "KPI 조회 중..."
        : "최신 시세 다시 조회";
  const strategyCompareTitle =
    strategyCompareMode === "ABCDE"
      ? `A~E 최근 ${activeKpiLabel} KPI & 월배당금 비교`
      : strategyCompareMode === "A_MODES"
        ? `A 전략: 안정/중립/성장 최근 ${activeKpiLabel} KPI & 월배당금 비교`
        : strategyCompareMode === "B_MODES"
          ? `B 전략: 안정/중립/성장 최근 ${activeKpiLabel} KPI & 월배당금 비교`
          : strategyCompareMode === "A_GROWTH_SP500"
            ? `${activeKpiLabel} KPI 비교: A(성장) vs ${SP500_BENCHMARK_DISPLAY}`
            : "";

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

  return (
    <div className="neo-theme min-h-dvh overflow-x-hidden px-2.5 py-3 text-slate-100 sm:px-4 sm:py-6">
      <div className="mx-auto max-w-[880px] space-y-4">
        <p className="px-1 text-[10px] tracking-[0.08em] text-slate-500">
          {PRODUCED_BY_LABEL}
        </p>
        <header className="neo-panel rounded-3xl p-4 backdrop-blur sm:p-5">
          <h1 className="ai-title text-lg font-black tracking-tight text-slate-900 sm:text-2xl">
            절세계좌 자산배분 투자
          </h1>
          <p className="mt-1 text-xs text-slate-500 sm:text-sm">
            투자금액과 전략(A~E)을 선택하면 최신 시세를 우선 반영해 종목별 주식수, 선택한 기간 KPI, 월배당 추정, 검산 차이까지 한 번에 보여줍니다.
          </p>
          <p className="mt-2 text-[11px] text-slate-500 sm:text-xs">
            핵심 기능: 최신 시세 자동 조회 · 종목별 비중/수량 요약 · KPI 계산 기간 선택(1년/6개월/3개월/1개월) · 실데이터 기준 월배당금 · 투자금액 검산
          </p>
        </header>

        <section className="neo-panel rounded-3xl p-4 sm:p-5">
          <h2 className="text-sm font-bold text-slate-700 sm:text-base">투자 조건 선택</h2>

          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-500">투자금액</p>
              <input
                className="neo-input w-full rounded-xl px-3 py-2.5 text-right text-base font-bold text-slate-900 outline-none ring-brand-300 transition focus:ring"
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
              <div className="mt-2 grid grid-cols-3 gap-2">
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
                    className="neo-btn rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 sm:text-sm"
                  >
                    +{quick.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1 text-xs font-semibold text-slate-500">투자방식</p>
              <div className="grid grid-cols-5 gap-2">
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
                      className={`rounded-lg border px-2 py-2 text-sm font-bold transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] ${
                        active
                          ? "neo-btn border-brand-500 bg-brand-700 text-white shadow-[0_14px_28px_rgba(0,0,0,0.34)]"
                          : "neo-btn border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:text-brand-700"
                      }`}
                    >
                      {strategy}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1.5 text-[11px] text-slate-500 sm:grid-cols-2">
                {(["A", "B", "C", "D", "E"] as StrategyType[]).map((strategy) => (
                  <p key={strategy}>
                    <span className="font-semibold text-slate-700">{strategy}</span> · {strategyDescriptions[strategy]}
                  </p>
                ))}
              </div>
            </div>

            {requiresMode && (
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-500">A/B 투자성향 선택</p>
                <div className="grid grid-cols-3 gap-2">
                  {(["안정형", "중립형", "성장형"] as PortfolioMode[]).map((mode) => {
                    const active = selection.mode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setSelection((prev) => ({ ...prev, mode }))}
                        className={`rounded-lg border px-2 py-2 text-xs font-bold transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] sm:text-sm ${
                          active
                            ? "neo-btn border-brand-600 bg-brand-700 text-white shadow-[0_14px_28px_rgba(0,0,0,0.34)]"
                            : "neo-btn border-slate-200 bg-white text-slate-700 hover:border-brand-200 hover:bg-brand-50"
                        }`}
                      >
                        {mode}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <p className="mb-1 text-xs font-semibold text-slate-500">KPI 기간 선택</p>
              <div className="grid grid-cols-3 gap-2">
                {KPI_WINDOW_LIST.map((window) => {
                  const active = selection.kpiWindow === window;
                  return (
                    <button
                      key={window}
                      type="button"
                      onClick={() => setSelection((prev) => ({ ...prev, kpiWindow: window }))}
                      className={`rounded-lg border px-2 py-2 text-xs font-bold transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] sm:text-sm ${
                        active
                          ? "neo-btn border-brand-600 bg-brand-700 text-white shadow-[0_14px_28px_rgba(0,0,0,0.34)]"
                          : "neo-btn border-slate-200 bg-white text-slate-700 hover:border-brand-200 hover:bg-brand-50"
                      }`}
                    >
                      {KPI_WINDOW_LABELS[window]}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={handleShowResult}
              disabled={!canShowResult || isRefreshing}
              className="neo-btn w-full rounded-xl border border-brand-200 bg-brand-100 px-4 py-3 text-sm font-bold text-brand-700 transition-transform duration-150 active:translate-y-[1px] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRefreshing ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-600 border-r-transparent" />
                  조회 진행 중...
                </span>
              ) : (
                "결과 보기"
              )}
            </button>
          </div>
        </section>

        {resultPortfolio && appliedSelection && (
          <section className="neo-panel rounded-3xl p-4 sm:p-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-2 text-xs sm:text-sm">
                <span className="neo-chip px-3 py-1 font-semibold">
                  투자금액 {formatCurrencyKRW(appliedSelection.principal)}
                </span>
                <span className="neo-chip px-3 py-1 font-semibold">
                  방식 {appliedSelection.strategy}
                </span>
                {(appliedSelection.strategy === "A" || appliedSelection.strategy === "B") && (
                  <span className="neo-chip px-3 py-1 font-semibold">
                    성향 {appliedSelection.mode}
                  </span>
                )}
                <span className="neo-chip px-3 py-1 font-semibold">
                  KPI {KPI_WINDOW_LABELS[appliedSelection.kpiWindow]}
                </span>
              </div>
              <button
                type="button"
                onClick={handleRefreshLatest}
                disabled={isRefreshing}
                className={`neo-btn rounded-xl border px-3 py-2 text-xs font-semibold transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] sm:text-sm ${
                  isRefreshing
                    ? "border-brand-300 bg-brand-100 text-brand-700 shadow-sm shadow-brand-100"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                } disabled:cursor-not-allowed`}
              >
                {isRefreshing ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-600 border-r-transparent" />
                    {refreshActionLabel}
                  </span>
                ) : (
                  "최신 시세 다시 조회"
                )}
              </button>
            </div>

            <div className="neo-subpanel mt-3 rounded-2xl p-3">
              <p className="text-xs text-slate-600">{refreshMessage}</p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-brand-100/80">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    isRefreshing
                      ? "animate-pulse bg-gradient-to-r from-brand-500 via-brand-400 to-brand-300"
                      : "bg-brand-400"
                  }`}
                  style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }}
                />
              </div>
              {isRefreshing && (
                <div className="neo-subpanel mt-2 flex items-center gap-2 rounded-xl px-2.5 py-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-600" />
                  </span>
                  <p className="text-xs font-bold text-brand-700">
                    {refreshState.stage === "price"
                      ? "실시간 시세 조회를 진행 중입니다."
                      : "KPI용 히스토리 조회를 진행 중입니다."}
                  </p>
                </div>
              )}
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                <p className="text-slate-600">단계: <span className="font-semibold">{refreshStageText[refreshState.stage]}</span></p>
                <p className="text-slate-600">진행률: <span className="font-semibold">{doneSteps}/{totalSteps} ({progressPercent}%)</span></p>
                <p className="text-slate-600">현재 처리: <span className="font-semibold">{refreshState.currentName ?? "-"}</span></p>
                <p className="text-slate-600">시세 성공/실패: <span className="font-semibold">{refreshState.priceSuccess}/{refreshState.priceFailed}</span></p>
                <p className="text-slate-600">KPI 성공/실패: <span className="font-semibold">{refreshState.kpiSuccess}/{refreshState.kpiFailed}</span></p>
                <p className="text-slate-600">포트폴리오 적용 시세: <span className="font-semibold">{refreshState.priceAppliedDate ?? "-"}</span></p>
                <p className="text-slate-600">최종 갱신: <span className="font-semibold">{refreshState.lastUpdatedAt ?? "-"}</span></p>
              </div>
            </div>

            <div className="neo-subpanel mt-3 rounded-2xl p-3">
              <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                <p className="text-slate-600">
                  종목 수 <span className="font-bold text-slate-900">{resultRows.length}개</span>
                </p>
                <p className="text-slate-600">
                  비중 합계 <span className="font-bold text-slate-900">{formatPercent(weightSum)}</span>
                </p>
                <p className="text-slate-600">
                  투자금액 합계 <span className="font-bold text-slate-900">{formatCurrencyKRW(totalCheckAmount)}</span>
                </p>
              </div>
            </div>

            <div className="neo-subpanel mt-3 rounded-2xl p-3">
              <p className="text-sm font-bold text-slate-800">월배당금 정보</p>
              <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <p className="text-slate-600">
                  배당률 기준:{" "}
                  <span className="font-semibold text-slate-900">
                    {selectedWindowKpi != null ? formatPercent(selectedWindowKpi.annualDividendYield) : "-"}
                  </span>
                </p>
                <p className="text-slate-600">
                  실데이터 연배당금:{" "}
                  <span className="font-semibold text-slate-900">
                    {annualDividendBySelectedWindow != null ? formatCurrencyKRW(annualDividendBySelectedWindow) : "-"}
                  </span>
                </p>
                <p className="text-slate-600">
                  실데이터 월배당금:{" "}
                  <span className="font-bold text-brand-700">
                    {monthlyDividendBySelectedWindow != null ? formatCurrencyKRW(monthlyDividendBySelectedWindow) : "-"}
                  </span>
                </p>
                <p className="text-[11px] text-slate-500">
                  선택한 KPI 기간(실데이터) 배당률을 투자금액에 적용해 산출합니다.
                </p>
              </div>
            </div>

            <div className="neo-subpanel mt-3 rounded-2xl p-3">
              <p className="text-sm font-bold text-slate-700">KPI 비교 (평균 vs 최근 {activeKpiLabel})</p>
              <p className="mt-1 text-[11px] text-slate-500">CAGR은 배당 재투자 기준으로 계산합니다.</p>
              <p className="mt-1 text-xs text-slate-500">
                {activeKpiLabel} KPI 계산 기간:{" "}
                <span className="font-semibold text-slate-700">
                  {selectedKpiPeriod
                    ? `${formatYmdFromDashDate(selectedKpiPeriod.start)}~${formatYmdFromDashDate(selectedKpiPeriod.end)}`
                    : "-"}
                </span>
              </p>
              <div className="mt-2 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div className="neo-subpanel rounded-xl p-3">
                  <p className="text-xs font-semibold text-slate-500">평균 KPI (전략 기준)</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <p>CAGR <span className="font-semibold text-slate-800">{averageKpi ? formatPercent(averageKpi.cagr) : "-"}</span></p>
                    <p>MDD <span className="font-semibold text-slate-800">{averageKpi ? formatPercent(averageKpi.mdd) : "-"}</span></p>
                    <p>Sharpe <span className="font-semibold text-slate-800">{averageKpi ? averageKpi.sharpe.toFixed(2) : "-"}</span></p>
                    <p>배당률 <span className="font-semibold text-slate-800">{averageKpi ? formatPercent(averageKpi.annualDividendYield) : "-"}</span></p>
                  </div>
                </div>
                <div className="neo-subpanel rounded-xl p-3">
                  <p className="text-xs font-semibold text-slate-500">최근 {activeKpiLabel} KPI (실데이터)</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <p>CAGR <span className="font-semibold text-slate-800">{selectedWindowKpi ? formatPercent(selectedWindowKpi.cagr) : "-"}</span></p>
                    <p>MDD <span className="font-semibold text-slate-800">{selectedWindowKpi ? formatPercent(selectedWindowKpi.mdd) : "-"}</span></p>
                    <p>Sharpe <span className="font-semibold text-slate-800">{selectedWindowKpi ? selectedWindowKpi.sharpe.toFixed(2) : "-"}</span></p>
                    <p>배당률 <span className="font-semibold text-slate-800">{selectedWindowKpi ? formatPercent(selectedWindowKpi.annualDividendYield) : "-"}</span></p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {resultRows.map(({ item, quantity, amount, priceFetchedDate, periodReturnByWindow, appliedDividendYield }) => (
                <details
                  key={item.id}
                  className="neo-subpanel neo-disclosure overflow-hidden rounded-xl"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-slate-900">
                        <span className="mr-1 text-brand-700">[{formatPercent(item.weight)}]</span>
                        {item.name}
                      </p>
                      <p className="text-xs text-slate-400">{item.code}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-base font-black text-slate-900">{formatNumber(quantity)}주</p>
                      <p className="text-xs font-semibold text-slate-500">{formatCurrencyKRW(amount)}</p>
                    </div>
                  </summary>
                  <div className="grid grid-cols-2 gap-2 border-t border-slate-100 bg-slate-50/60 px-3 py-3 text-xs text-slate-600">
                    <p>분류: <span className="font-semibold text-slate-800">{item.category}</span></p>
                    <p>세부분류: <span className="font-semibold text-slate-800">{item.subCategory}</span></p>
                    <p>현재가: <span className="font-semibold text-slate-800">{formatCurrencyKRW(item.price)}</span></p>
                    <p>조회일: <span className="font-semibold text-slate-800">{priceFetchedDate ?? "-"}</span></p>
                    <p>비중: <span className="font-semibold text-slate-800">{formatPercent(item.weight)}</span></p>
                    <p>실지급 배당률: <span className="font-semibold text-slate-800">{formatPercent(appliedDividendYield)}</span></p>
                    <p>투자금액: <span className="font-semibold text-slate-800">{formatCurrencyKRW(amount)}</span></p>
                    <p>1년 기간 수익률(실제): <span className="font-semibold text-slate-800">{periodReturnByWindow["1Y"] != null ? formatPercent(periodReturnByWindow["1Y"]) : "-"}</span></p>
                    <p>6개월 기간 수익률(실제): <span className="font-semibold text-slate-800">{periodReturnByWindow["6M"] != null ? formatPercent(periodReturnByWindow["6M"]) : "-"}</span></p>
                    <p>3개월 기간 수익률(실제): <span className="font-semibold text-slate-800">{periodReturnByWindow["3M"] != null ? formatPercent(periodReturnByWindow["3M"]) : "-"}</span></p>
                    <p>1개월 기간 수익률(실제): <span className="font-semibold text-slate-800">{periodReturnByWindow["1M"] != null ? formatPercent(periodReturnByWindow["1M"]) : "-"}</span></p>
                  </div>
                </details>
              ))}
            </div>

            <div className="neo-subpanel mt-3 rounded-2xl p-3">
              <p className="text-sm font-bold text-slate-800">검산</p>
              <div className="mt-2 grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
                <p className="text-slate-600">
                  입력 투자금액: <span className="font-semibold text-slate-900">{formatCurrencyKRW(investedPrincipal)}</span>
                </p>
                <p className="text-slate-600">
                  종목 합계(현재가×주식수): <span className="font-semibold text-slate-900">{formatCurrencyKRW(totalCheckAmount)}</span>
                </p>
                <p className="text-slate-600 sm:col-span-2">
                  차이 금액(투자금액-종목합계):{" "}
                  <span
                    className={`font-bold ${
                      roundingGap > 0 ? "text-emerald-700" : roundingGap < 0 ? "text-rose-700" : "text-slate-800"
                    }`}
                  >
                    {formatSignedCurrencyKRW(roundingGap)}
                  </span>
                  <span className="ml-1 text-slate-500">({roundingGapLabel})</span>
                </p>
                <p className="text-[11px] text-slate-500 sm:col-span-2">
                  주식수 정수 반올림 적용으로 소액 차이가 발생할 수 있습니다.
                </p>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <button
                type="button"
                onClick={() => void handleCompareOneYearKpi("ABCDE")}
                disabled={strategyCompareLoading}
                className={`neo-btn rounded-xl border px-3 py-2 text-xs font-bold transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] sm:text-sm ${
                  strategyCompareMode === "ABCDE"
                    ? "border-brand-600 bg-brand-700 text-white shadow-[0_10px_22px_rgba(0,0,0,0.34)]"
                    : "border-brand-300 bg-brand-100 text-brand-800 shadow-[0_8px_16px_rgba(0,0,0,0.2)]"
                } disabled:cursor-not-allowed disabled:opacity-70`}
              >
                {strategyCompareLoading && strategyCompareMode === "ABCDE" ? "조회 중..." : `${activeKpiLabel} KPI 비교 (ABCDE 5개)`}
              </button>
              <button
                type="button"
                onClick={() => void handleCompareOneYearKpi("A_MODES")}
                disabled={strategyCompareLoading}
                className={`neo-btn rounded-xl border px-3 py-2 text-xs font-bold transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] sm:text-sm ${
                  strategyCompareMode === "A_MODES"
                    ? "border-brand-600 bg-brand-700 text-white shadow-[0_10px_22px_rgba(0,0,0,0.34)]"
                    : "border-brand-300 bg-brand-100 text-brand-800 shadow-[0_8px_16px_rgba(0,0,0,0.2)]"
                } disabled:cursor-not-allowed disabled:opacity-70`}
              >
                {strategyCompareLoading && strategyCompareMode === "A_MODES" ? "조회 중..." : `${activeKpiLabel} KPI 비교 (A: 안정·중립·성장)`}
              </button>
              <button
                type="button"
                onClick={() => void handleCompareOneYearKpi("B_MODES")}
                disabled={strategyCompareLoading}
                className={`neo-btn rounded-xl border px-3 py-2 text-xs font-bold transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] sm:text-sm ${
                  strategyCompareMode === "B_MODES"
                    ? "border-brand-600 bg-brand-700 text-white shadow-[0_10px_22px_rgba(0,0,0,0.34)]"
                    : "border-brand-300 bg-brand-100 text-brand-800 shadow-[0_8px_16px_rgba(0,0,0,0.2)]"
                } disabled:cursor-not-allowed disabled:opacity-70`}
              >
                {strategyCompareLoading && strategyCompareMode === "B_MODES" ? "조회 중..." : `${activeKpiLabel} KPI 비교 (B: 안정·중립·성장)`}
              </button>
              <button
                type="button"
                onClick={() => void handleCompareOneYearKpi("A_GROWTH_SP500")}
                disabled={strategyCompareLoading}
                className={`neo-btn rounded-xl border px-3 py-2 text-xs font-bold transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] sm:text-sm ${
                  strategyCompareMode === "A_GROWTH_SP500"
                    ? "border-brand-600 bg-brand-700 text-white shadow-[0_10px_22px_rgba(0,0,0,0.34)]"
                    : "border-brand-300 bg-brand-100 text-brand-800 shadow-[0_8px_16px_rgba(0,0,0,0.2)]"
                } disabled:cursor-not-allowed disabled:opacity-70`}
              >
                {strategyCompareLoading && strategyCompareMode === "A_GROWTH_SP500"
                  ? "조회 중..."
                  : `${activeKpiLabel} KPI 비교: A(성장) vs S&P500`}
              </button>
            </div>

            {strategyCompareMode && (
              <div className="neo-subpanel mt-3 rounded-2xl p-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-bold text-slate-800">{strategyCompareTitle}</p>
                  <p className="text-xs text-slate-500">
                    투자금액 기준:{" "}
                    <span className="font-semibold text-slate-700">
                      {formatCurrencyKRW(strategyComparePrincipal ?? investedPrincipal)}
                    </span>
                    {strategyCompareUpdatedAt && (
                      <span className="ml-2">
                        · 갱신일 <span className="font-semibold text-slate-700">{strategyCompareUpdatedAt}</span>
                      </span>
                    )}
                  </p>
                </div>

                {strategyCompareError ? (
                  <p className="mt-2 text-xs font-semibold text-rose-700">{strategyCompareError}</p>
                ) : (
                  <div className="neo-subpanel mt-2 max-h-[360px] overflow-auto rounded-xl">
                    <table className="neo-table min-w-[680px] w-full text-xs">
                      <thead className="text-slate-600">
                        <tr>
                          <th className="sticky-col sticky left-0 top-0 z-30 w-[84px] min-w-[84px] border-r border-slate-200 bg-slate-50 px-2 py-2 text-left font-semibold">구분</th>
                          <th className="sticky top-0 z-20 bg-slate-50 px-2 py-2 text-right font-semibold">CAGR</th>
                          <th className="sticky top-0 z-20 bg-slate-50 px-2 py-2 text-right font-semibold">MDD</th>
                          <th className="sticky top-0 z-20 bg-slate-50 px-2 py-2 text-right font-semibold">Sharpe</th>
                          <th className="sticky top-0 z-20 bg-slate-50 px-2 py-2 text-right font-semibold">배당률</th>
                          <th className="sticky top-0 z-20 bg-slate-50 px-2 py-2 text-right font-semibold">월배당금</th>
                          <th className="sticky top-0 z-20 bg-slate-50 px-2 py-2 text-left font-semibold">KPI 기간</th>
                        </tr>
                      </thead>
                      <tbody>
                        {strategyCompareRows.map((row) => (
                          <tr key={row.id} className="border-t border-slate-100">
                            <td className="sticky-col sticky left-0 z-10 w-[84px] min-w-[84px] border-r border-slate-100 bg-white px-2 py-2 font-semibold text-slate-800">
                              {row.label}
                            </td>
                            <td className="px-2 py-2 text-right text-slate-700">
                              {row.kpi ? formatPercent(row.kpi.cagr) : "-"}
                            </td>
                            <td className="px-2 py-2 text-right text-slate-700">
                              {row.kpi ? formatPercent(row.kpi.mdd) : "-"}
                            </td>
                            <td className="px-2 py-2 text-right text-slate-700">
                              {row.kpi ? row.kpi.sharpe.toFixed(2) : "-"}
                            </td>
                            <td className="px-2 py-2 text-right text-slate-700">
                              {row.kpi ? formatPercent(row.kpi.annualDividendYield) : "-"}
                            </td>
                            <td className="px-2 py-2 text-right font-semibold text-brand-700">
                              {row.monthlyDividend != null ? formatCurrencyKRW(row.monthlyDividend) : "-"}
                            </td>
                            <td className="px-2 py-2 text-slate-600">
                              {row.periodStart && row.periodEnd
                                ? `${formatYmdFromDashDate(row.periodStart)}~${formatYmdFromDashDate(row.periodEnd)}`
                                : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        <section className="neo-panel rounded-3xl p-4 sm:p-5">
          <h2 className="text-sm font-bold text-slate-700 sm:text-base">복리 계산기</h2>
          <p className="mt-1 text-xs text-slate-500">
            원금·추가원금·목표수익률·기간을 입력하면 복리 기준 총 자산과 수익금을 계산합니다.
          </p>

          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-500">최초 투자원금</p>
              <input
                className="neo-input w-full rounded-xl px-3 py-2.5 text-right text-base font-bold text-slate-900 outline-none ring-brand-300 transition focus:ring"
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
              <div className="mt-2 grid grid-cols-3 gap-2">
                {COMPOUND_INITIAL_QUICK_ADD.map((quick) => (
                  <button
                    key={quick.label}
                    type="button"
                    onClick={() =>
                      setCompoundInitialPrincipal((prev) =>
                        sanitizeNonNegativeNumber(prev + quick.amount, 0)
                      )
                    }
                    className="neo-btn rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 sm:text-sm"
                  >
                    +{quick.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1 text-xs font-semibold text-slate-500">매년 추가원금</p>
              <input
                className="neo-input w-full rounded-xl px-3 py-2.5 text-right text-base font-bold text-slate-900 outline-none ring-brand-300 transition focus:ring"
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
              <div className="mt-2 grid grid-cols-2 gap-2">
                {COMPOUND_ANNUAL_QUICK_ADD.map((quick) => (
                  <button
                    key={quick.label}
                    type="button"
                    onClick={() =>
                      setCompoundAnnualContribution((prev) =>
                        sanitizeNonNegativeNumber(prev + quick.amount, 0)
                      )
                    }
                    className="neo-btn rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 transition-transform duration-150 active:translate-y-[1px] active:scale-[0.98] hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 sm:text-sm"
                  >
                    +{quick.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-500">목표 수익률 %</p>
                <input
                  className="neo-input w-full rounded-xl px-3 py-2.5 text-right text-base font-bold text-slate-900 outline-none ring-brand-300 transition focus:ring"
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
                <p className="mb-1 text-xs font-semibold text-slate-500">투자 기간 (년)</p>
                <input
                  className="neo-input w-full rounded-xl px-3 py-2.5 text-right text-base font-bold text-slate-900 outline-none ring-brand-300 transition focus:ring"
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

          <div className="neo-subpanel mt-3 rounded-2xl p-3">
            <p className="text-sm font-bold text-slate-800">총 자산 결과</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <p className="text-slate-600">
                누적 원금 <span className="font-semibold text-slate-900">{formatCurrencyKRW(compoundFinal.principalSum)}</span>
              </p>
              <p className="text-slate-600">
                총 자산 <span className="font-semibold text-slate-900">{formatCurrencyKRW(compoundFinal.totalAsset)}</span>
              </p>
              <p className="text-slate-600">
                수익금 <span className={`font-bold ${compoundFinal.profit >= 0 ? "text-brand-700" : "text-rose-700"}`}>{formatSignedCurrencyKRW(compoundFinal.profit)}</span>
              </p>
              <p className="text-slate-600">
                누적 수익률 <span className="font-semibold text-slate-900">{formatPercent(compoundTotalReturnPercent)}</span>
              </p>
            </div>
          </div>

          <div className="neo-subpanel mt-3 rounded-2xl p-3">
            <p className="text-sm font-bold text-slate-800">수익률 그래프 및 최종 평가</p>
            <div className="mt-2 overflow-hidden rounded-xl border border-brand-200/70 bg-white/75 p-2">
              <svg viewBox={`0 0 ${compoundChart.width} ${compoundChart.height}`} className="h-40 w-full">
                <polygon points={compoundChart.area} fill="rgba(255, 255, 255, 0.1)" />
                <polyline
                  points={compoundChart.principalLine}
                  fill="none"
                  stroke="rgba(101, 123, 156, 0.65)"
                  strokeWidth="1.6"
                  strokeDasharray="4 4"
                />
                <polyline
                  points={compoundChart.assetLine}
                  fill="none"
                  stroke="rgba(255, 255, 255, 0.88)"
                  strokeWidth="2.4"
                />
              </svg>
              <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                {compoundChart.labels.map((label) => (
                  <span key={label.key}>{label.label}</span>
                ))}
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-slate-600">
                <span>상단 {compoundChart.yTop}</span>
                <span>하단 {compoundChart.yBottom}</span>
              </div>
              <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <span className="h-[2px] w-4 bg-brand-300" />
                  총 자산
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-[2px] w-4 border-t border-dashed border-slate-300" />
                  누적 원금
                </span>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">{compoundEvaluationText}</p>
          </div>
        </section>

        <p className="pb-1 text-center text-[10px] tracking-[0.08em] text-slate-500">
          {PRODUCED_BY_LABEL}
        </p>
      </div>
    </div>
  );
}

export default App;
