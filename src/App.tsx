import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import PortfolioTabs from "./components/PortfolioTabs";
import PortfolioSummary from "./components/PortfolioSummary";
import PortfolioTable from "./components/PortfolioTable";
import AllocationDonut from "./components/AllocationDonut";
import CustomPortfolioForm from "./components/CustomPortfolioForm";
import { initialPortfolios } from "./data/portfolios";
import type { Portfolio } from "./types/portfolio";
import {
  calcCheckAmount,
  calcMonthlyDividend,
  calcSafeAssetWeight,
  calcShareCount,
  calcWeightSum,
} from "./utils/calculations";
import { fetchPricesByCodes } from "./utils/priceFetcher";
import { fetchOneYearHistoriesByCodes, type PricePoint } from "./utils/priceFetcher";
import {
  sanitizeNonNegativeNumber,
  sanitizePortfoliosFromUnknown,
} from "./utils/portfolioSanitizer";
import { calculatePortfolioKpiFromOneYearHistory } from "./utils/kpiCalculator";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeWeights(weights: number[]): number[] {
  const sum = weights.reduce((acc, cur) => acc + cur, 0);
  if (sum === 0) return weights.map(() => 0);
  const scaled = weights.map((w) => (w / sum) * 100);
  const rounded = scaled.map((w) => Math.round(w * 100) / 100);
  const current = rounded.reduce((acc, cur) => acc + cur, 0);
  const diff = Math.round((100 - current) * 100) / 100;
  if (rounded.length > 0) rounded[rounded.length - 1] = rounded[rounded.length - 1] + diff;
  return rounded;
}

function makeIdFromName(name: string): string {
  const slug = name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w가-힣-]/g, "")
    .slice(0, 24);
  return `${slug || "custom"}_${Date.now()}`;
}

function App() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>(() => deepClone(initialPortfolios));
  const [activeId, setActiveId] = useState<string>(initialPortfolios[0].id);
  const [integerShareMode, setIntegerShareMode] = useState<boolean>(false);
  const [priceLoading, setPriceLoading] = useState<boolean>(false);
  const [priceStatus, setPriceStatus] = useState<string>("기본 가격 사용 중");
  const [historyByCode, setHistoryByCode] = useState<Record<string, PricePoint[]>>({});
  const [kpiMode, setKpiMode] = useState<"target" | "history">("history");
  const [priceDate, setPriceDate] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const didAutoRefreshRef = useRef(false);
  const priceLoadingRef = useRef(false);

  const activePortfolio = useMemo(
    () => portfolios.find((p) => p.id === activeId) ?? portfolios[0] ?? initialPortfolios[0],
    [activeId, portfolios]
  );

  const computedKpiByPortfolio = useMemo(() => {
    return portfolios.reduce<Record<string, Portfolio["kpi"]>>((acc, portfolio) => {
      const computed = calculatePortfolioKpiFromOneYearHistory(portfolio.items, historyByCode);
      if (computed) acc[portfolio.id] = computed;
      return acc;
    }, {});
  }, [historyByCode, portfolios]);

  const activeKpi =
    kpiMode === "history"
      ? (computedKpiByPortfolio[activePortfolio.id] ?? activePortfolio.kpi)
      : activePortfolio.kpi;
  const hasHistoryKpi = Boolean(computedKpiByPortfolio[activePortfolio.id]);

  const weightSum = useMemo(() => calcWeightSum(activePortfolio.items), [activePortfolio.items]);
  const safeWeight = useMemo(
    () => calcSafeAssetWeight(activePortfolio.items),
    [activePortfolio.items]
  );
  const riskyWeight = Math.max(0, weightSum - safeWeight);
  const monthlyDividend = useMemo(
    () => calcMonthlyDividend(activePortfolio.principal, activeKpi.annualDividendYield),
    [activeKpi.annualDividendYield, activePortfolio.principal]
  );

  const checkTotal = useMemo(() => {
    return activePortfolio.items.reduce((sum, item) => {
      const qty = calcShareCount(activePortfolio.principal, item.weight, item.price, {
        integerMode: integerShareMode,
        precision: 4,
      });
      return sum + calcCheckAmount(item.price, qty);
    }, 0);
  }, [activePortfolio.items, activePortfolio.principal, integerShareMode]);

  const diffFromPrincipal = activePortfolio.principal - checkTotal;
  const canDeleteActive = portfolios.length > 1 && activePortfolio.isCustom === true;

  const updatePortfolio = (id: string, updater: (portfolio: Portfolio) => Portfolio) => {
    setPortfolios((prev) => prev.map((portfolio) => (portfolio.id === id ? updater(portfolio) : portfolio)));
  };

  const refreshPrices = async () => {
    if (priceLoadingRef.current) return;
    const codeNameMap = portfolios.reduce<Record<string, string>>((acc, portfolio) => {
      portfolio.items.forEach((item) => {
        if (!acc[item.code]) acc[item.code] = item.name;
      });
      return acc;
    }, {});
    const codes = [...new Set(portfolios.flatMap((portfolio) => portfolio.items.map((item) => item.code)))];
    if (codes.length === 0) return;

    priceLoadingRef.current = true;
    setPriceLoading(true);
    setPriceStatus("실시간 시세/1년 KPI 조회를 시작합니다...");
    try {
      const { prices, failedCodes } = await fetchPricesByCodes(
        codes,
        (done, total, code) => {
          const name = codeNameMap[code] ?? code;
          setPriceStatus(`시세 조회 ${done}/${total}: ${name}`);
        }
      );
      const successCount = Object.keys(prices).length;

      if (successCount > 0) {
        setPortfolios((prev) =>
          prev.map((portfolio) => ({
            ...portfolio,
            items: portfolio.items.map((item) =>
              prices[item.code] ? { ...item, price: prices[item.code] } : item
            ),
          }))
        );
      }

      const {
        historyByCode: loadedHistory,
        failedCodes: failedHistoryCodes,
      } = await fetchOneYearHistoriesByCodes(codes, (done, total, code) => {
        const name = codeNameMap[code] ?? code;
        setPriceStatus(`KPI(1년) 조회 ${done}/${total}: ${name}`);
      });

      if (Object.keys(loadedHistory).length > 0) {
        setHistoryByCode(loadedHistory);
      }

      const now = new Date();
      const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
      const timeText = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(
        now.getDate()
      ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`;
      const dateLabel = `${String(now.getFullYear()).slice(2)}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}(${dayNames[now.getDay()]})`;
      if (successCount > 0) setPriceDate(dateLabel);

      const historySuccessCount = Object.keys(loadedHistory).length;
      if (successCount === 0) {
        setPriceStatus("시세 조회 실패: 기존 가격 유지");
      } else if (failedCodes.length > 0 || failedHistoryCodes.length > 0) {
        setPriceStatus(
          `시세·KPI 갱신 ${timeText} · 시세 ${successCount}/${codes.length}, KPI ${historySuccessCount}/${codes.length}`
        );
      } else {
        setPriceStatus(
          `시세·KPI 갱신 ${timeText} · 시세 ${successCount}/${codes.length}, KPI ${historySuccessCount}/${codes.length}`
        );
      }
    } catch {
      setPriceStatus("시세/KPI 조회 중 오류가 발생했습니다. 기존 값을 유지합니다.");
    } finally {
      priceLoadingRef.current = false;
      setPriceLoading(false);
    }
  };

  const handlePrincipalChange = (value: number) => {
    updatePortfolio(activeId, (portfolio) => ({
      ...portfolio,
      principal: sanitizeNonNegativeNumber(value, 0),
    }));
  };

  const handleUpdateItem = (
    itemId: string,
    field: "price" | "weight" | "dividendYield",
    value: number
  ) => {
    const sanitizedValue = sanitizeNonNegativeNumber(value, 0);
    updatePortfolio(activeId, (portfolio) => ({
      ...portfolio,
      items: portfolio.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              [field]: sanitizedValue,
            }
          : item
      ),
    }));
  };

  const handleReset = () => {
    setPortfolios(deepClone(initialPortfolios));
    setActiveId(initialPortfolios[0].id);
    setIntegerShareMode(false);
    setHistoryByCode({});
    setPriceStatus("기본 가격으로 초기화되었습니다.");
  };

  const handleSaveJson = () => {
    const blob = new Blob([JSON.stringify(portfolios, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = "portfolio-data.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };

  const handleLoadJson = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const loaded = sanitizePortfoliosFromUnknown(parsed);
      if (loaded.length === 0) throw new Error("invalid portfolio array");
      setPortfolios(loaded);
      setActiveId(loaded[0].id);
      setPriceStatus("JSON 데이터를 불러왔습니다.");
    } catch {
      window.alert("JSON 파일 형식이 올바르지 않습니다.");
    } finally {
      e.target.value = "";
    }
  };

  const handleNormalize = () => {
    updatePortfolio(activeId, (portfolio) => {
      const adjusted = normalizeWeights(portfolio.items.map((item) => item.weight));
      return {
        ...portfolio,
        items: portfolio.items.map((item, index) => ({
          ...item,
          weight: adjusted[index],
        })),
      };
    });
  };

  const handleCopyPortfolio = () => {
    const copiedId = makeIdFromName(`${activePortfolio.name}_복사본`);
    const copy: Portfolio = {
      ...deepClone(activePortfolio),
      id: copiedId,
      name: `${activePortfolio.name}_복사본`,
      isCustom: true,
      items: activePortfolio.items.map((item, index) => ({
        ...item,
        id: `${copiedId}_item_${index + 1}`,
      })),
    };
    setPortfolios((prev) => [...prev, copy]);
    setActiveId(copy.id);
  };

  const handleCreateCustomPortfolio = (
    name: string,
    principalLabel: "투자금" | "원금",
    principal: number
  ) => {
    const customId = makeIdFromName(name);
    const custom: Portfolio = {
      ...deepClone(activePortfolio),
      id: customId,
      name,
      principalLabel,
      principal: sanitizeNonNegativeNumber(principal, 0),
      isCustom: true,
      items: activePortfolio.items.map((item, index) => ({
        ...item,
        id: `${customId}_item_${index + 1}`,
      })),
    };
    setPortfolios((prev) => [...prev, custom]);
    setActiveId(custom.id);
  };

  const handleDeleteActivePortfolio = () => {
    if (!canDeleteActive) return;
    const filtered = portfolios.filter((portfolio) => portfolio.id !== activePortfolio.id);
    if (filtered.length === 0) return;
    setPortfolios(filtered);
    setActiveId(filtered[0].id);
  };

  useEffect(() => {
    if (didAutoRefreshRef.current) return;
    didAutoRefreshRef.current = true;
    void refreshPrices();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshPrices();
    }, 1000 * 60 * 10);

    const onFocus = () => {
      void refreshPrices();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshPrices();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [portfolios]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_20%_10%,#ffe3d6_0,#fff6ef_35%,#fdfdff_100%)] px-4 py-6 text-slate-900">
      <div className="mx-auto max-w-[1320px] space-y-5">
        <header className="rounded-3xl border border-white/60 bg-white/80 p-5 shadow-glow backdrop-blur">
          {/* 제목 + 핵심 CTA */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900 sm:text-2xl lg:text-3xl">
                포트폴리오 투자 계산기
              </h1>
              <p className="mt-0.5 text-xs text-slate-500">실시간 시세·KPI 기반 자산배분 계산기</p>
            </div>
            <button
              type="button"
              onClick={() => void refreshPrices()}
              disabled={priceLoading}
              className="shrink-0 rounded-xl border border-brand-200 bg-brand-100 px-4 py-2.5 text-sm font-bold text-brand-700 hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {priceLoading ? "조회중..." : "시세·KPI 갱신"}
            </button>
          </div>

          {/* 상태 표시 */}
          <div className="mt-2.5 flex items-center gap-2">
            {priceLoading && (
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-500" />
            )}
            <p className="truncate text-xs text-slate-500">{priceStatus}</p>
          </div>

          {/* 포트폴리오 탭 */}
          <div className="mt-3">
            <PortfolioTabs portfolios={portfolios} activeId={activeId} onChange={setActiveId} />
          </div>

          {/* 자주 쓰는 기능 + 더보기 토글 */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleNormalize}
              className="rounded-xl border border-amber-200 bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-700 hover:bg-amber-200"
            >
              비중 100% 맞추기
            </button>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              {showAdvanced ? "접기 ▲" : "더보기 ▼"}
            </button>
          </div>

          {/* 더보기: 부가 기능 */}
          {showAdvanced && (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleReset}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  초기화
                </button>
                <button
                  type="button"
                  onClick={handleCopyPortfolio}
                  className="rounded-xl border border-fuchsia-200 bg-fuchsia-100 px-3 py-2 text-sm font-semibold text-fuchsia-700 hover:bg-fuchsia-200"
                >
                  포트폴리오 복사
                </button>
                <button
                  type="button"
                  onClick={handleDeleteActivePortfolio}
                  disabled={!canDeleteActive}
                  className="rounded-xl border border-rose-200 bg-rose-100 px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  현재 포트 삭제
                </button>
                <button
                  type="button"
                  onClick={handleSaveJson}
                  className="rounded-xl border border-emerald-200 bg-emerald-100 px-3 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-200"
                >
                  JSON 저장
                </button>
                <button
                  type="button"
                  onClick={handleLoadJson}
                  className="rounded-xl border border-sky-200 bg-sky-100 px-3 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-200"
                >
                  JSON 불러오기
                </button>
                <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white bg-white px-3 py-2 text-xs font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    checked={integerShareMode}
                    onChange={(e) => setIntegerShareMode(e.target.checked)}
                  />
                  정수 주식 단위
                </label>
                <button
                  type="button"
                  onClick={() => setShowCustomForm((v) => !v)}
                  className="rounded-xl border border-fuchsia-200 bg-fuchsia-50 px-3 py-2 text-sm font-semibold text-fuchsia-700 hover:bg-fuchsia-100"
                >
                  {showCustomForm ? "포트폴리오 추가 숨기기" : "+ 포트폴리오 직접 추가"}
                </button>
              </div>
              {showCustomForm && (
                <CustomPortfolioForm onCreate={handleCreateCustomPortfolio} />
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            onChange={handleFileChange}
            className="hidden"
          />
        </header>

        <main className="grid gap-4 xl:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <PortfolioSummary
              principalLabel={activePortfolio.principalLabel}
              principal={activePortfolio.principal}
              weightSum={weightSum}
              safeWeight={safeWeight}
              monthlyDividend={monthlyDividend}
              checkTotal={checkTotal}
              diffFromPrincipal={diffFromPrincipal}
              kpi={activeKpi}
              kpiMode={kpiMode}
              onKpiModeChange={setKpiMode}
              hasHistoryKpi={hasHistoryKpi}
              onPrincipalChange={handlePrincipalChange}
            />
            <PortfolioTable
              principal={activePortfolio.principal}
              items={activePortfolio.items}
              integerShareMode={integerShareMode}
              priceDate={priceDate}
              onUpdateItem={handleUpdateItem}
            />
          </div>
          <AllocationDonut safeWeight={safeWeight} riskyWeight={riskyWeight} />
        </main>
      </div>
    </div>
  );
}

export default App;
