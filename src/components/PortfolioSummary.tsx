import { useState } from "react";
import KpiCards from "./KpiCards";
import { formatCurrencyKRW, formatNumber, formatPercent } from "../utils/formatters";
import type { PortfolioKPI } from "../types/portfolio";

type Props = {
  principalLabel: string;
  principal: number;
  weightSum: number;
  safeWeight: number;
  monthlyDividend: number;
  checkTotal: number;
  diffFromPrincipal: number;
  kpi: PortfolioKPI;
  kpiMode: "target" | "history";
  onKpiModeChange: (mode: "target" | "history") => void;
  hasHistoryKpi: boolean;
  onPrincipalChange: (value: number) => void;
};

function PortfolioSummary({
  principalLabel,
  principal,
  weightSum,
  safeWeight,
  monthlyDividend,
  checkTotal,
  diffFromPrincipal,
  kpi,
  kpiMode,
  onKpiModeChange,
  hasHistoryKpi,
  onPrincipalChange,
}: Props) {
  const [principalFocused, setPrincipalFocused] = useState(false);
  const weightWarn = Math.abs(weightSum - 100) > 0.0001;
  const roundedMonthlyDividend = Math.round(monthlyDividend);
  const diffOk = Math.abs(diffFromPrincipal) < 1;
  const riskyWeight = Math.max(0, weightSum - safeWeight);

  return (
    <section className="space-y-3">
      {/* Row 1: 투자금(모바일 full-width) + 비중합계 + 안전자산 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* 투자금: 모바일에서 전체 너비 */}
        <div className="col-span-1 rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm sm:col-span-2 lg:col-span-1">
          <label className="mb-2 block text-sm font-semibold text-slate-600">
            {principalLabel}
          </label>
          <input
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-right text-lg font-bold text-slate-900 outline-none ring-brand-300 transition focus:ring"
            inputMode="decimal"
            value={
              principalFocused
                ? principal === 0
                  ? ""
                  : String(principal)
                : principal.toLocaleString("ko-KR")
            }
            onFocus={(e) => {
              setPrincipalFocused(true);
              e.currentTarget.select();
            }}
            onBlur={() => setPrincipalFocused(false)}
            onChange={(e) =>
              onPrincipalChange(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)
            }
          />
          <p className="mt-1.5 text-xs text-slate-500">{formatCurrencyKRW(principal)}</p>
        </div>

        {/* 비중 합계 */}
        <div className="rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm">
          <p className="text-xs font-semibold text-slate-500">비중 합계</p>
          <p
            className={`mt-1.5 text-2xl font-black ${weightWarn ? "text-rose-600" : "text-emerald-600"}`}
          >
            {formatPercent(weightSum)}
          </p>
          <p
            className={`mt-1 text-xs font-semibold ${weightWarn ? "text-rose-500" : "text-emerald-600"}`}
          >
            {weightWarn ? "⚠ 100%가 아닙니다" : "✓ 정상"}
          </p>
        </div>

        {/* 안전자산 비중 */}
        <div className="rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm">
          <p className="text-xs font-semibold text-slate-500">안전자산 비중</p>
          <p className="mt-1.5 text-2xl font-black text-sky-600">{formatPercent(safeWeight)}</p>
          <p className="mt-1 text-xs text-slate-400">위험자산 {formatPercent(riskyWeight)}</p>
        </div>
      </div>

      {/* Row 2: 월배당 + 투자금액 합계 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm">
          <p className="text-xs font-semibold text-slate-500">예상 월배당</p>
          <p className="mt-1.5 text-2xl font-black text-violet-600">
            {formatNumber(roundedMonthlyDividend)}
            <span className="ml-1 text-sm font-semibold text-slate-500">만원</span>
          </p>
          <p className="mt-1 text-xs text-slate-400">연 배당수익률 기준 월환산</p>
        </div>

        <div className="rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm">
          <p className="text-xs font-semibold text-slate-500">투자금액 합계</p>
          <p className="mt-1.5 text-lg font-black text-slate-800">{formatCurrencyKRW(checkTotal)}</p>
          <p className={`mt-1 text-xs font-semibold ${diffOk ? "text-emerald-600" : "text-rose-500"}`}>
            {diffOk ? "✓ 원금 일치" : `차이 ${formatCurrencyKRW(diffFromPrincipal)}`}
          </p>
        </div>
      </div>

      <KpiCards
        kpi={kpi}
        mode={kpiMode}
        hasHistory={hasHistoryKpi}
        onModeChange={onKpiModeChange}
      />
    </section>
  );
}

export default PortfolioSummary;
